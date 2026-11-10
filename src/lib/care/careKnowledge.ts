/**
 * A small, conservative general-care knowledge base.
 *
 * This is the assistant's "textbook shelf". It exists so a question like "what
 * is orthopnoea?" or "what are the warning signs of sepsis?" gets a useful,
 * source-labelled answer even when the LLM is offline. It is intentionally
 * short and general; it is not a guideline, formulary or substitute for local
 * policy. Nothing here is specific to a patient.
 */
import type { Passage } from "./retrieval";

export const CARE_KNOWLEDGE: Passage[] = [
  {
    id: "kb_heart_failure",
    kind: "knowledge",
    title: "General guidance — heart failure",
    text: "Heart failure means the heart is not pumping as effectively as it should. Common symptoms are breathlessness, fatigue, ankle swelling and needing extra pillows to sleep (orthopnoea). Daily morning weights are useful because a rapid gain of about 2 kg in three days can signal fluid retention. Nurses commonly check weight, blood pressure, heart rate, oxygen saturation, fluid intake and output, electrolytes and renal function. Escalate new resting breathlessness, chest pain, fainting or rapid weight gain.",
    keywords: "heart failure cardiac fluid overload orthopnoea oedema edema weight diuretic furosemide breathless",
  },
  {
    id: "kb_hypertension",
    kind: "knowledge",
    title: "General guidance — high blood pressure",
    text: "A single blood-pressure reading is less reliable than a series taken at the same time of day with the correct cuff size and the arm supported. For most adults, clinic readings repeatedly at or above 140/90 mmHg need review; home targets are often lower and should follow local guidance. Check for headache, visual change, chest pain or breathlessness when the reading is very high. Do not change a patient's antihypertensive dose without a prescriber.",
    keywords: "hypertension blood pressure bp systolic diastolic amlodipine reading cuff target",
  },
  {
    id: "kb_diabetes",
    kind: "knowledge",
    title: "General guidance — type 2 diabetes and low blood sugar",
    text: "Type 2 diabetes management includes medication adherence, activity, diet and regular glucose monitoring. Hypoglycaemia can cause shaking, sweating, confusion, hunger, irritability or drowsiness. If the patient is conscious and can swallow, follow the local hypoglycaemia protocol (often a fast-acting carbohydrate, then a longer-acting snack); if they are unconscious, do not give anything by mouth and call emergency help. Recheck glucose after treatment and document the episode.",
    keywords: "diabetes glucose sugar hypoglycaemia hypoglycemia metformin gliclazide insulin dizzy sweating",
  },
  {
    id: "kb_asthma",
    kind: "knowledge",
    title: "General guidance — asthma",
    text: "Asthma causes variable airflow obstruction with wheeze, cough, chest tightness and breathlessness. A reliever inhaler (usually a short-acting beta agonist) is for quick symptom relief; a preventer inhaler is taken regularly to reduce inflammation. Check inhaler technique and spacer use. Escalate if the patient cannot complete a sentence, is using the reliever repeatedly, has blue lips, drowsiness or a silent chest.",
    keywords: "asthma wheeze inhaler salbutamol budesonide peak flow breathless reliever preventer",
  },
  {
    id: "kb_copd",
    kind: "knowledge",
    title: "General guidance — COPD",
    text: "COPD is a chronic lung condition, often caused by smoking, with breathlessness, cough and sputum. Monitor oxygen saturation against the patient's prescribed target range, because some people with COPD retain carbon dioxide and should not receive high-flow oxygen without a prescribed target. Check inhaler technique, encourage smoking cessation and refer for pulmonary rehabilitation when appropriate. Escalate worsening breathlessness, confusion, fever or a change in sputum.",
    keywords: "copd chronic obstructive pulmonary disease oxygen saturation target tiotropium prednisolone exacerbation",
  },
  {
    id: "kb_sepsis",
    kind: "knowledge",
    title: "General guidance — sepsis warning signs",
    text: "Sepsis is a life-threatening response to infection. Warning signs include new confusion, rapid breathing, low blood pressure, a very high or very low temperature, a fast heart rate, mottled or cold skin, reduced urine output and a feeling of impending doom. Use the local sepsis screening tool and escalate urgently; early antibiotics and fluids are time-critical. This is general information, not a diagnosis.",
    keywords: "sepsis infection fever confusion breathing fast blood pressure urine mottled emergency screening",
  },
  {
    id: "kb_stroke",
    kind: "knowledge",
    title: "General guidance — stroke (FAST)",
    text: "Use FAST: Face drooping, Arm weakness, Speech difficulty, Time to call emergency services. Other signs include sudden vision loss, severe headache, dizziness or loss of balance. Note the time symptoms started, keep the patient safe and do not give food or drink. Call 112 or the local emergency number immediately.",
    keywords: "stroke fast face arm speech emergency neurological weakness droop",
  },
  {
    id: "kb_chest_pain",
    kind: "knowledge",
    title: "General guidance — chest pain",
    text: "Chest pain can be cardiac, respiratory, musculoskeletal or gastrointestinal. Treat new central chest pain, pain radiating to the arm or jaw, sweating, nausea or breathlessness as an emergency until assessed. Call emergency services, keep the patient still and monitor breathing and consciousness. Do not give aspirin unless local protocol and the patient's allergy history allow it. This is general guidance, not a diagnosis.",
    keywords: "chest pain cardiac heart attack emergency radiating arm jaw sweating breathless",
  },
  {
    id: "kb_wound",
    kind: "knowledge",
    title: "General guidance — wound infection",
    text: "A healing wound may be mildly pink at the edges. Spreading redness, warmth, swelling, pus, increasing pain, fever or a bad smell suggest infection and need clinical review. Keep the wound clean and dry, follow the dressing plan, and do not squeeze or probe it. Photos taken in good light at the same distance are useful for tracking change.",
    keywords: "wound infection incision redness pus fever dressing surgical appendectomy",
  },
  {
    id: "kb_falls",
    kind: "knowledge",
    title: "General guidance — falls prevention",
    text: "Falls risk rises with dizziness on standing, low blood pressure, sedating medication, poor vision, weakness, confusion and a previous fall. Check blood pressure lying and standing, review medicines, remove trip hazards, improve lighting, encourage appropriate footwear and consider a walking aid and occupational-therapy assessment. After a fall, check for injury, head strike and loss of consciousness before moving the patient.",
    keywords: "falls fall prevention dizziness orthostatic blood pressure mobility lighting trip hazard occupational therapy",
  },
  {
    id: "kb_vitals",
    kind: "knowledge",
    title: "General guidance — adult vital sign reference ranges",
    text: "Typical adult resting ranges are approximately: respiratory rate 12–20 breaths per minute, oxygen saturation 94–98% on room air (with a prescribed target for some COPD patients), heart rate 60–100 beats per minute, temperature 36.1–37.2 °C, and blood pressure around 90/60 to 120/80 mmHg. A single number matters less than the trend and the patient's own baseline. Always follow local reference ranges.",
    keywords: "vital signs normal range respiratory rate oxygen saturation heart rate temperature blood pressure adult",
  },
  {
    id: "kb_sbar",
    kind: "knowledge",
    title: "General guidance — SBAR handoff",
    text: "SBAR stands for Situation, Background, Assessment, Recommendation. Situation: who the patient is and what is happening now. Background: relevant diagnosis, medications, allergies and recent events. Assessment: current observations, trends and your interpretation within your scope. Recommendation: what you need, by when, and from whom. Keep it concise, state the facts, and read back the plan.",
    keywords: "sbar handoff communication situation background assessment recommendation escalation",
  },
  {
    id: "kb_medication",
    kind: "knowledge",
    title: "General guidance — medication adherence",
    text: "Before assuming non-adherence, ask open questions about missed doses, side effects, cost, supply problems, swallowing difficulties and understanding of the regimen. Use a pill organiser, reminders or pharmacy support where appropriate. Never advise a patient to stop or double a prescribed medicine without the prescriber; refer concerns for review.",
    keywords: "medication adherence missed dose side effect prescription pharmacy reminder compliance",
  },
  {
    id: "kb_antibiotics",
    kind: "knowledge",
    title: "General guidance — antibiotics",
    text: "Complete the prescribed course unless the prescriber says otherwise. Common side effects include nausea, diarrhoea and rash; seek advice for severe diarrhoea, facial swelling, breathing difficulty or a widespread rash. Antibiotics do not treat viral colds. Document the indication, start date and planned review.",
    keywords: "antibiotic course amoxicillin diarrhoea rash allergy resistance infection",
  },
  {
    id: "kb_pain",
    kind: "knowledge",
    title: "General guidance — pain assessment",
    text: "Ask about location, quality, timing, triggers, severity (for example 0–10), effect on sleep and function, and what has helped. Use the patient's preferred scale and reassess after an intervention. New severe pain, pain with fever, chest pain or pain after trauma needs prompt clinical review. Pain is what the patient says it is.",
    keywords: "pain score assessment severity analgesia paracetamol location quality reassess",
  },
  {
    id: "kb_breathless",
    kind: "knowledge",
    title: "General guidance — breathlessness and anxiety",
    text: "Breathlessness has physical and emotional components. Sit the patient upright, loosen tight clothing, check oxygen saturation and respiratory rate, and coach slow breathing if it is safe to do so. Do not assume anxiety until hypoxia, pulmonary embolism, heart failure, asthma, COPD and infection have been considered. Escalate quickly if the patient cannot speak in sentences or is exhausting.",
    keywords: "breathless breathlessness anxiety panic oxygen saturation respiratory rate upright",
  },
  {
    id: "kb_dehydration",
    kind: "knowledge",
    title: "General guidance — hydration and fluid balance",
    text: "Signs of dehydration include thirst, dry mouth, dark urine, reduced urine output, dizziness on standing and confusion in older adults. Fluid balance records should include all drinks, intravenous fluids, urine, vomit and diarrhoea where relevant. Some patients, such as those with heart failure or kidney disease, have a prescribed fluid restriction — check the care plan before encouraging extra fluids.",
    keywords: "hydration dehydration fluid balance urine output intake heart failure restriction kidney",
  },
  {
    id: "kb_fever",
    kind: "knowledge",
    title: "General guidance — fever",
    text: "Fever is a temperature above the patient's normal range, often taken as 38 °C or higher. Check for infection symptoms, recent surgery, rashes, confusion and dehydration. Use the local antipyretic and sepsis screening policy. A very high temperature, low blood pressure, confusion or breathlessness needs urgent review. Older adults may not mount a fever even with serious infection.",
    keywords: "fever temperature infection sepsis paracetamol confusion older adult",
  },
  {
    id: "kb_constipation",
    kind: "knowledge",
    title: "General guidance — constipation",
    text: "Constipation is infrequent or difficult bowel movements. Ask about frequency, consistency, pain, bleeding, medication (especially opioids) and fluid and fibre intake. Encourage fluids and movement if safe. New blood in the stool, severe pain, vomiting or weight loss needs clinical review. Follow the patient's prescribed bowel plan.",
    keywords: "constipation bowel stool opioid fibre fluid laxative bleeding",
  },
  {
    id: "kb_sleep",
    kind: "knowledge",
    title: "General guidance — sleep and orthopnoea",
    text: "Orthopnoea is breathlessness when lying flat, often relieved by sitting up or using extra pillows. It can occur in heart failure, COPD, asthma and obesity. Ask how many pillows the patient now needs compared with their usual baseline. New orthopnoea, waking gasping or ankle swelling should be escalated for same-day review.",
    keywords: "sleep orthopnoea pillows breathless lying flat heart failure waking gasping",
  },
  {
    id: "kb_privacy",
    kind: "knowledge",
    title: "General guidance — privacy and data handling",
    text: "Share only the minimum patient information needed for care, use authorised systems, and do not read records you do not need. This demo stores synthetic data locally or in the configured Redis store; it is not a production clinical system. In a real deployment, follow your organisation's privacy, consent, retention and audit policies.",
    keywords: "privacy confidentiality data gdpr hipaa consent audit record access",
  },
  {
    id: "kb_carespeak",
    kind: "knowledge",
    title: "About CareSpeak",
    text: "CareSpeak is a care-communication demo. It links a patient's device readings, an authorised clinical record and a voice assistant. The nurse portal can brief you, answer record questions, read live signals, draft an SBAR handoff and send a message to the patient's screen. It is not an emergency service and does not replace clinical judgement.",
    keywords: "carespeak about demo capabilities nurse portal voice call readings sbar message",
  },
  {
    id: "kb_emergency_numbers",
    kind: "knowledge",
    title: "General guidance — emergency numbers",
    text: "In India the emergency number is 112. In the UK and many countries it is 999 or 112; in the US and Canada it is 911. Use the number for the patient's location and follow local policy. If you are unsure, call the local emergency number and ask for help.",
    keywords: "emergency number 112 911 999 ambulance call",
  },
  {
    id: "kb_handover",
    kind: "knowledge",
    title: "General guidance — escalation",
    text: "Escalate when a reading crosses the patient's agreed threshold, when you are worried about the patient, or when the care plan is not working. State the patient, the concern, the current observations, what you have already tried and what you need. Record the time, the person you spoke to and the plan. If the patient is deteriorating, do not wait for a routine review.",
    keywords: "escalation deteriorate worried threshold senior clinician plan record time",
  },
  {
    id: "kb_hydration_heat",
    kind: "knowledge",
    title: "General guidance — heat and hydration",
    text: "Heat can worsen dizziness, confusion and breathlessness, especially in older adults. Encourage shade, loose clothing and regular fluids unless a restriction is prescribed. Check medicines that affect sweating or blood pressure. Heatstroke is an emergency: hot dry skin, confusion, collapse or a very high temperature needs urgent cooling and emergency help.",
    keywords: "heat hydration summer dizziness older adult heatstroke fluids",
  },
  {
    id: "kb_smoking",
    kind: "knowledge",
    title: "General guidance — smoking cessation",
    text: "Stopping smoking is one of the most effective things a patient can do for heart and lung health. Ask permission before advising, offer evidence-based support and medication through the local cessation service, and record the patient's readiness. Relapse is common; offer another attempt without judgement.",
    keywords: "smoking cessation quit tobacco vaping support heart lung",
  },
];

export const CARE_KNOWLEDGE_BY_ID = new Map(CARE_KNOWLEDGE.map((p) => [p.id, p]));
