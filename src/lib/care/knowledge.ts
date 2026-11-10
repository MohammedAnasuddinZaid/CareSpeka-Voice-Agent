/**
 * General care knowledge, question routing and small talk for the assistant.
 *
 * The nurse portal is scoped to one patient, but nurses ask three different
 * kinds of question in the same conversation:
 *
 *   1. "What is she on?"            -> the patient's record
 *   2. "What is heart failure?"      -> general clinical knowledge
 *   3. "Tell me a joke"              -> normal human conversation
 *
 * Routing them explicitly keeps the assistant honest: a general answer is never
 * presented as a patient fact, and a record question never gets a textbook
 * answer when the chart is silent. The knowledge base below is deliberately
 * short, conservative and editable — it is not a clinical guideline.
 */
import type { ClinicalPatient } from "./types";
import type { Passage } from "./retrieval";

export type QuestionScope = "record" | "general" | "mixed" | "chitchat" | "meta" | "emergency";

export interface QuestionRoute {
  scope: QuestionScope;
  /** Why the router chose this scope — useful in tests and debug output. */
  reason: string;
  /** True when the patient is named or referred to with a pronoun. */
  patientSpecific: boolean;
}

const RECORD_NOUNS =
  /\b(patient|chart|record|records|note|notes|history|background|medication|medications|medicine|medicines|meds|dose|dosage|prescription|allerg(?:y|ies)|condition|conditions|diagnos(?:is|es)|observation|observations|vital|vitals|reading|readings|blood pressure|bp|heart rate|pulse|oxygen|saturation|sats|temperature|temp|weight|glucose|sugar|lab|labs|bloods|scan|report|reports|call|calls|session|transcript|task|tasks|follow.?up|care plan|sbar|chart|document|letter|discharge|admission|encounter|visit|appointment|symptom|symptoms)\b/i;

const GENERAL_HINTS =
  /\b(what is|what are|what's|explain|define|definition|meaning of|how does|how do|why does|why do|difference between|tell me about|teach me|guideline|guidelines|normal range|reference range|side effects?|complication|causes?|risk factors?|prevention|prevent|treatment|management of|first aid|warning signs?|red flags?|protocol)\b/i;

const SUBJECT =
  /\b(she|he|they|her|his|him|their|them|the patient|this patient|patient)\b/i;

const CHITCHAT =
  /^(?:hi|hello|hey|hiya|howdy|good (?:morning|afternoon|evening)|yo|greetings)\b|^(?:thanks|thank you|cheers|much appreciated|appreciate it)\b|^(?:bye|goodbye|good night|see you|that'?s all|nothing else)\b|^(?:ok|okay|alright|got it|sure|yes|yeah|no|nope)\s*[.!?]*$/i;

const META =
  /\b(who are you|what are you|your name|tell me about yourself|are you (?:a )?(?:human|real|ai|robot|person|bot)|what can you do|how can you help|what do you do|what should i ask|how do i use|are you there|can you hear me|do you understand|what language)\b/i;

const SMALLTALK =
  /\b(joke|funny|make me laugh|cheer me up|fun fact|interesting fact|tell me something interesting|did you know|meaning of life|why are we here|what is the point|sing|song|rap|poem|marry me|date me|do you love me|be my (?:girlfriend|boyfriend)|are you single|i love you|i'?m bored|so bored|entertain me|pizza|coffee|tea|snack|lunch|dinner|hungry|how are you|how'?s it going|are you okay|you good|repeat|say that again|come again|what did you say|pardon|weather|forecast|what(?:'s| is) the (?:time|date)|what day is it|today'?s date|how old are you|when were you (?:made|built)|do you dream|do you sleep|where do you live|can you (?:see|hear|watch) me|are you watching|on camera|testing|test test)\b/i;

const ARITHMETIC =
  /^(?:what is|what'?s|whats|calculate|compute|how much is|how much does)?\s*-?\d[\d\s.()]*[+\-*/%]\s*[\d(][\d\s.()+\-*/%]*=?\s*\??$/i;

const PERCENT_MATH =
  /^(?:what is|what'?s|whats)?\s*\d+(?:\.\d+)?\s*(?:%|percent)\s+of\s+\d+(?:\.\d+)?\s*\??$/i;

const EMERGENCY_SYMPTOM =
  /\b(chest pain|crushing chest|heart attack|can'?t breathe|cannot breathe|not breathing|stopped breathing|gasping|collapsed|unconscious|unresponsive|stroke|face droop|slurred speech|severe bleeding|bleeding heavily|bleeding a lot|bleeding (?:now|badly)|won'?t stop bleeding|suicid(?:e|al)|overdose|seizure|choking|anaphylaxis|swollen tongue|throat closing)\b/i;

/**
 * A symptom the nurse has just ruled out ("no chest pain", "denies chest
 * pain", "she hasn't collapsed") is not a live red flag. Only clear negation
 * in the same clause counts: "not sure if she has chest pain" stays ambiguous
 * and is still treated as a report.
 */
const NEGATED =
  /\b(?:no|never|without|denies|denied|denying|negative for|free of|no longer)\b|\b(?:does|do|did|is|are|was|were|has|have|had)\s+not\b|\b(?:hasn'?t|haven'?t|hadn'?t|doesn'?t|don'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t)\b/i;

const RESOLVED =
  /\b(?:has|have|had|is|are|was|were)?\s*(?:gone|resolved|settled|eased|subsided|improved|better now|no longer)\b/i;

const CLAUSE_BREAK = /[.;!?]|\bbut\b|\bhowever\b|\balthough\b/i;

/**
 * Split out so safety wins over education when the nurse reports a symptom:
 * "she has chest pain, help me understand" is still a live report. A pure
 * question ("what causes chest pain") has no such subject and stays educational.
 */
const REPORTING_SYMPTOM =
  /\b(?:she|he|they|the patient|patient)\s+(?:has|have|had|is|are|feels?|reports?|complains? of|describes?|says)\b/i;

function symptomIsNegated(lower: string): boolean {
  const match = EMERGENCY_SYMPTOM.exec(lower);
  if (!match || match.index == null) return false;
  const before = lower.slice(Math.max(0, match.index - 56), match.index);
  const clause = before.split(CLAUSE_BREAK).pop() ?? before;
  return NEGATED.test(clause);
}

function symptomIsResolved(lower: string): boolean {
  const match = EMERGENCY_SYMPTOM.exec(lower);
  if (!match || match.index == null) return false;
  const after = lower.slice(match.index + match[0].length, match.index + match[0].length + 48);
  const clause = after.split(CLAUSE_BREAK)[0] ?? after;
  return RESOLVED.test(clause);
}

const EMERGENCY_NOW =
  /\b(right now|now|currently|suddenly|just (?:started|had|happened)|started (?:having|to|with)|(?:is|are|was) having|collapsed|unresponsive|not breathing|stopped breathing|bleeding heavily|bleeding a lot|emergency|immediately|quick(?:ly)?)\b/i;

const HISTORICAL =
  /\b(when did|when was|history|previous|past medical|last time|in the past|documented|recorded)\b/i;

const EDUCATION =
  /\b(what(?:'s| is| are)|(?:what|which) (?:should|do|would)|how (?:do|should)|define|definition|meaning of|tell me about|difference between|warning signs?|red flags?|protocol|guideline|teach|explain|understand|signs? of|symptoms? of|first aid for|management of|causes?|triggers?|risk factors? (?:for|of))\b/i;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Words that appear in many unrelated condition names. Matching one of these
 * alone ("heart" in "heart attack" vs the chart's "heart failure") would make
 * an educational question look patient-specific.
 */
const GENERIC_CONDITION_WORDS = new Set([
  "heart",
  "failure",
  "kidney",
  "liver",
  "lung",
  "blood",
  "pressure",
  "disease",
  "disorder",
  "syndrome",
  "chronic",
  "acute",
  "cardiac",
  "renal",
  "hepatic",
  "respiratory",
  "infection",
  "cancer",
  "pain",
  "anxiety",
  "depression",
  "essential",
  "primary",
  "secondary",
  "left",
  "right",
  "lower",
  "upper",
  "small",
  "large",
  "cell",
  "mellitus",
  "stage",
  "recovery",
]);

function nameForms(patient?: ClinicalPatient | null): string[] {
  if (!patient) return [];
  const parts = patient.displayName.split(/\s+/).filter(Boolean);
  const forms = [patient.displayName, ...parts];
  return [...new Set(forms.filter((f) => f.length >= 3))].sort((a, b) => b.length - a.length);
}

function mentionsPatient(question: string, patient?: ClinicalPatient | null): boolean {
  const q = question.toLowerCase();
  if (SUBJECT.test(q)) return true;
  return nameForms(patient).some((name) => new RegExp(`\\b${escapeRe(name.toLowerCase())}\\b`, "i").test(q));
}

function mentionsPatientCondition(question: string, patient?: ClinicalPatient | null): boolean {
  if (!patient) return false;
  const q = question.toLowerCase();
  return patient.conditions.some((c) => {
    const core = c.name
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(chronic|acute|essential|type|mild|moderate|severe|persistent|recovery)\b/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    // The whole condition name is the strongest signal ("heart failure").
    if (core.length >= 4) {
      const phrase = new RegExp(`(^|[^a-z0-9])${escapeRe(core)}(?=$|[^a-z0-9])`, "i");
      if (phrase.test(q)) return true;
    }
    // Otherwise only a distinctive word counts. Generic clinical words are
    // skipped so "what are the warning signs of a heart attack?" is not
    // mistaken for a question about this patient's heart failure.
    const words = core
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !GENERIC_CONDITION_WORDS.has(w));
    return words.some((w) =>
      new RegExp(`(^|[^a-z0-9])${escapeRe(w)}(?:s|es)?(?=$|[^a-z0-9])`, "i").test(q)
    );
  });
}

/**
 * Decides what kind of question this is. The order matters: safety first, then
 * conversation, then record vs general knowledge.
 */
export function classifyQuestion(question: string, patient?: ClinicalPatient | null): QuestionRoute {
  const q = question.trim();
  const lower = q.toLowerCase();
  const patientSpecific = mentionsPatient(q, patient);

  if (!q) return { scope: "record", reason: "empty question", patientSpecific };

  if (EMERGENCY_SYMPTOM.test(lower)) {
    const educational = EDUCATION.test(lower);
    const happeningNow = EMERGENCY_NOW.test(lower);
    const historical = HISTORICAL.test(lower);
    const negated = symptomIsNegated(lower);
    const resolved = symptomIsResolved(lower);
    const reported = REPORTING_SYMPTOM.test(lower);
    // A ruled-out or already-resolved symptom is a record statement, not a new
    // emergency. An explicit "now"/"collapsed" still wins over education or
    // history, and a reported symptom wins over a "help me understand" tail.
    if (
      !negated &&
      !resolved &&
      (happeningNow || (!historical && (reported || !educational)))
    ) {
      return {
        scope: "emergency",
        reason: "red-flag symptom described as happening now",
        patientSpecific,
      };
    }
  }

  if (META.test(lower)) return { scope: "meta", reason: "question about the assistant", patientSpecific };
  if (CHITCHAT.test(lower)) return { scope: "chitchat", reason: "greeting, thanks or sign-off", patientSpecific };
  if (SMALLTALK.test(lower) || ((ARITHMETIC.test(lower) || PERCENT_MATH.test(lower)) && !RECORD_NOUNS.test(lower))) {
    return { scope: "chitchat", reason: "conversation, fun or arithmetic", patientSpecific };
  }

  const recordNoun = RECORD_NOUNS.test(lower);
  const generalHint = GENERAL_HINTS.test(lower);
  const conditionHit = mentionsPatientCondition(q, patient);

  if ((patientSpecific || recordNoun) && generalHint) {
    return {
      scope: "mixed",
      reason: "patient-specific question with a general clinical concept",
      patientSpecific,
    };
  }
  if (patientSpecific || recordNoun) {
    return { scope: "record", reason: "patient-specific or record vocabulary", patientSpecific };
  }
  if (generalHint || conditionHit) {
    return {
      scope: conditionHit ? "mixed" : "general",
      reason: conditionHit ? "mentions a condition in this patient's chart" : "general clinical question",
      patientSpecific,
    };
  }
  if (conditionHit) return { scope: "mixed", reason: "mentions a condition in this patient's chart", patientSpecific };

  // A bare question in an open patient session is nearly always about them.
  return { scope: patient ? "record" : "general", reason: "default for the current context", patientSpecific };
}

// ---------------------------------------------------------------------------
// small talk — deterministic, warm answers that never need a model
// ---------------------------------------------------------------------------

function clean(question: string): string {
  return question
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}\s%+\-*/().]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- safe arithmetic -------------------------------------------------------

function evaluateArithmetic(expression: string): number | null {
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/%]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) return null;
  let at = 0;

  const peek = () => tokens[at];
  const take = () => tokens[at++];

  function primary(): number | null {
    const token = peek();
    if (token == null) return null;
    if (token === "(") {
      take();
      const value = addSub();
      if (peek() !== ")") return null;
      take();
      return value;
    }
    if (token === "-") {
      take();
      const value = primary();
      return value == null ? null : -value;
    }
    if (token === "+") {
      take();
      return primary();
    }
    if (/^\d/.test(token)) {
      take();
      return Number(token);
    }
    return null;
  }

  function mulDiv(): number | null {
    let left = primary();
    if (left == null) return null;
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const right = primary();
      if (right == null) return null;
      if (op === "*") left *= right;
      else if (op === "/") left = right === 0 ? NaN : left / right;
      else left = right === 0 ? NaN : left % right;
    }
    return left;
  }

  function addSub(): number | null {
    let left = mulDiv();
    if (left == null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const right = mulDiv();
      if (right == null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  const result = addSub();
  if (at !== tokens.length || !Number.isFinite(result) || result == null) return null;
  return result;
}

function tryMath(question: string): string | null {
  const lower = question.toLowerCase();
  const percent = lower.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*of\s*(\d+(?:\.\d+)?)/);
  if (percent) {
    const result = (Number(percent[1]) / 100) * Number(percent[2]);
    return `${percent[1]} percent of ${percent[2]} is ${Number(result.toFixed(4))}.`;
  }
  const stripped = lower
    .replace(/\b(what is|what's|whats|calculate|compute|how much is|how much does|equals?|equal to|math|please|the answer to)\b/g, " ")
    .replace(/\?/g, " ")
    .trim();
  if (!/\d/.test(stripped) || !/[+\-*/%()]/.test(stripped)) return null;
  const expression = stripped.replace(/\s+/g, "");
  if (!/^-?[\d.+\-*/%()]+$/.test(expression)) return null;
  const value = evaluateArithmetic(expression);
  if (value == null) return null;
  return `${expression} equals ${Number(value.toFixed(6))}.`;
}

const JOKES = [
  "Why did the blood pressure monitor take a holiday? It needed to unwind.",
  "I told the heart monitor a joke. It did not laugh, but the rate stayed steady — I'll take that as a win.",
  "Why was the stethoscope so calm? It had a lot on its chest and learned to listen.",
  "I asked the thermometer for a hot take. It said it was all measured out.",
];

const FACTS = [
  "A normal adult resting heart rate is usually between 60 and 100 beats per minute, but fitter people can sit lower.",
  "The word 'orthopnoea' means breathlessness when lying flat — it is why some people with heart failure need extra pillows.",
  "A single blood-pressure reading is less useful than a series taken at the same time of day.",
  "Hand hygiene is still the single most effective infection-prevention step in a care setting.",
];

function pick<T>(items: T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return items[hash % items.length];
}

export interface SmallTalkOptions {
  patient?: ClinicalPatient | null;
  lastAssistant?: string | null;
}

/**
 * Answers greetings, thanks, identity questions, jokes, arithmetic and other
 * non-clinical turns. Returns null when the question should go to retrieval or
 * the model instead.
 */
export function smallTalkAnswer(question: string, opts: SmallTalkOptions = {}): string | null {
  const q = clean(question);
  if (!q) return null;
  const name = opts.patient?.displayName?.split(/\s+/)[0] ?? null;
  const who = name ?? "your patient";

  if (/^(hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening|greetings|yo)\b/.test(q)) {
    return `Hello. I'm here with ${who}'s chart and live readings — what would you like to check?`;
  }
  if (/^(thanks|thank you|cheers|much appreciated|appreciate it|that helps)\b/.test(q)) {
    return "You're welcome. I'll keep the record and readings ready if you need anything else.";
  }
  if (/^(bye|goodbye|good night|see you|that's all|nothing else)\b/.test(q)) {
    return "Goodbye. The call transcript will be saved with this session.";
  }
  if (/\b(who are you|what are you|your name|are you (a )?(human|real|ai|robot|person|bot)|tell me about yourself)\b/.test(q)) {
    return "I'm the CareSpeak assistant — a local demo AI that reads this patient's authorised record and live device readings. I'm not a clinician, and I don't guess when the record is silent.";
  }
  if (/\b(how old are you|when were you (made|built)|do you dream|do you sleep|where do you live)\b/.test(q)) {
    return "I'm software, so I don't have an age or a bedtime. I run with this CareSpeak demo and answer from the record in front of me.";
  }
  if (/\b(what can you do|how can you help|what do you do|what should i ask|how do i use|what can i ask)\b/.test(q)) {
    return `You can ask me about ${who}'s history, medications, allergies, observations, inserted records, last call, follow-up tasks, live readings, or ask for an SBAR handoff. You can also ask a general care question, or just say hello.`;
  }
  if (/\b(can you (call|phone|dial|text) (911|112|emergency|the nurse|a doctor)|place a call|transfer me)\b/.test(q)) {
    return "I can't place emergency calls or transfer you. If this is an emergency, call 112 or your local emergency number now and alert someone nearby. I can brief the nurse from the record.";
  }
  if (/\b(joke|funny|make me laugh|cheer me up)\b/.test(q)) {
    return `${pick(JOKES, q)}${name ? ` Now — anything you want to check on ${name}?` : ""}`;
  }
  if (/\b(fun fact|interesting fact|tell me something interesting|did you know)\b/.test(q)) {
    return `${pick(FACTS, q)} Want me to relate that to ${who}'s chart?`;
  }
  if (/\b(meaning of life|why are we here|what is the point)\b/.test(q)) {
    return "The honest answer is that I don't know. My working answer today is: keep the patient safe, document clearly, and go home on time.";
  }
  if (/\b(sing|song|rap|poem)\b/.test(q)) {
    return "I'll spare you the singing — my voice is better suited to reading a chart. I can give you a two-line SBAR instead.";
  }
  if (/\b(marry me|date me|do you love me|be my (girlfriend|boyfriend)|are you single)\b/.test(q)) {
    return "That's kind, but I'm a demo care assistant and I'm already committed to this session. Let's keep it professional and useful.";
  }
  if (/\b(i love you|love you)\b/.test(q)) {
    return "I appreciate that. I'm here to help with the care record — what would you like to check?";
  }
  if (/\b(stupid|dumb|useless|idiot|shut up|hate you)\b/.test(q)) {
    return "Fair enough if I missed the mark. Tell me what you needed and I'll try the record again, or I'll say plainly when it isn't there.";
  }
  if (/\b(i'?m (tired|exhausted|stressed|overwhelmed|burnt out|busy)|long shift|rough day)\b/.test(q)) {
    return "That sounds like a long shift. I can take the chart-reading off your plate — ask me for a quick summary, the latest readings, or an SBAR.";
  }
  if (/\b(i'?m bored|so bored|entertain me)\b/.test(q)) {
    return `${pick(FACTS, q)} Or we could review ${who}'s care plan — your call.`;
  }
  if (/\b(pizza|coffee|tea|snack|lunch|dinner|hungry)\b/.test(q)) {
    return "I can't order anything, unfortunately. I can tell you whether the care plan mentions fluids, diet or appetite, though.";
  }
  if (/\b(how are you|how'?s it going|are you okay|you good)\b/.test(q)) {
    return "I'm running well and the record is loaded. More importantly — how can I help with this patient?";
  }
  if (/\b(are you there|can you hear me|do you understand|hello\?|testing|test test|1 2 3)\b/.test(q)) {
    return "I'm here and I can see the session. Ask me anything about the patient or the live readings.";
  }
  if (/\b(repeat|say that again|come again|what did you say|pardon)\b/.test(q)) {
    return opts.lastAssistant
      ? `Of course. I said: ${opts.lastAssistant}`
      : "I don't have a previous answer to repeat in this session yet.";
  }
  if (/\b(weather|forecast|rain|temperature outside)\b/.test(q)) {
    return "I don't have live weather data. Your phone's weather app will be more accurate — I can still read the patient's temperature if that's what you meant.";
  }
  if (/\b(what('s| is) the (time|date)|what day is it|today'?s date)\b/.test(q)) {
    return `It's ${new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" })} on this device.`;
  }
  if (/\b(what('s| is) my name|who am i)\b/.test(q)) {
    return "I can't see your account name from this session. I can see the patient and the care record — who would you like to review?";
  }
  if (/\b(can you (see|hear|watch) me|are you watching|on camera)\b/.test(q)) {
    return "No. This call uses the microphone for speech recognition and the patient's device readings; I can't see you.";
  }
  if (/\b(order|buy|book|reserve|send (an )?email|text|whatsapp)\b/.test(q)) {
    return "I can't order, book or send external messages in this demo. I can send a message to the patient's CareSpeak screen if you dictate one.";
  }
  if (/^(ok|okay|alright|got it|sure|yes|yeah|no|nope|hmm|mm|right)\s*[.!?]*$/.test(q)) {
    return "Understood. What would you like to check next?";
  }

  return tryMath(question);
}

// ---------------------------------------------------------------------------
// emergency answer
// ---------------------------------------------------------------------------

export function emergencyAnswer(question: string, patient?: ClinicalPatient | null): string {
  const name = patient?.displayName?.split(/\s+/)[0] ?? "the patient";
  const lower = question.toLowerCase();
  if (/suicid|self.?harm|overdose/.test(lower)) {
    return `This is a safety emergency for ${name}. Stay with them, remove means of harm if it is safe to do so, call 112 or your local emergency number now, and alert the senior clinician on duty. Do not leave them alone. I can read the record, but I cannot place the emergency call.`;
  }
  return `Treat this as an emergency for ${name}. Call 112 or your local emergency number now, alert the bedside or on-call clinician, and stay with the patient. Check airway, breathing and circulation; do not give food or drink. I can read the record and live readings, but I cannot examine the patient or place the emergency call.`;
}

/** Honest answer when neither the chart nor general knowledge has an answer. */
export function unknownAnswer(patient?: ClinicalPatient | null): string {
  const name = patient?.displayName ?? "this patient";
  return `I don't have a grounded answer to that in ${name}'s record, and I don't want to guess. I can search the inserted notes and call history again, or you can ask a general care question such as "what are the warning signs of sepsis?" or "what is a normal adult respiratory rate?".`;
}
