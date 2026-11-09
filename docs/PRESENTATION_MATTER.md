# CareSpeak — Slide-by-Slide Presentation Matter

**7-slide submission deck · Smart India Hackathon 2026**

> **What this document is.** Ready-to-paste slide copy, visuals, speaker notes, evidence tables, and references for a seven-slide presentation. It is written from the actual repository at commit `cd9941b` and from the clinical/technical sources listed on Slide 7. Every number is either measured in this repo, counted from the repo, or cited. Estimates and pre-specified targets are labelled as such.
>
> **What CareSpeak is not.** This is a working engineering prototype, not a regulated medical device. It does not diagnose, prescribe, or replace clinical judgement, and it has not yet been clinically validated. Slide 5 states this explicitly and shows the validation plan.

## Contents

- [Slide 1 — Problem Statement](#slide-1--problem-statement)
- [Slide 2 — Proposed Solution](#slide-2--proposed-solution)
- [Slide 3 — Key Features, Methodology & Implementation Process](#slide-3--key-features-methodology--implementation-process)
- [Slide 4 — Impact and Uses](#slide-4--impact-and-uses)
- [Slide 5 — Impact and Uses](#slide-5--impact-and-uses)
- [Slide 6 — Technology and Innovation](#slide-6--technology-and-innovation)
- [Slide 7 — Research and References](#slide-7--research-and-references)
- [Appendix A — 90-second demo script](#appendix-a--90-second-demo-script)
- [Appendix B — Anticipated judge questions](#appendix-b--anticipated-judge-questions)
- [Appendix C — Slide build checklist](#appendix-c--slide-build-checklist)
- [Appendix D — Fast facts (for rehearsal)](#appendix-d--fast-facts-for-rehearsal)
- [Appendix E — Repo evidence index](#appendix-e--repo-evidence-index)

**How to use each slide section**

| Block | Use |
|---|---|
| **On-slide copy** | Paste the short bullets/tables into the slide. |
| **Visual** | Build the diagram or choose the screenshot. |
| **Build note** | Layout guidance for a 16:9 slide. |
| **Speaker notes** | What to say; 60–120 seconds per slide. |
| **Likely questions** | Rehearsal prompts for the Q&A. |
| **Sources** | Footnote/citation mapping. |

---

## 0. Deck at a glance

| # | Slide title | Core message | Primary visual |
|---|---|---|---|
| 1 | **Problem Statement** | Care fails at the interface between a patient who cannot express and a clinician who cannot see. | Four-gap quadrant |
| 2 | **Proposed Solution** | One closed loop: sense → interpret → act → escalate → record. | Closed-loop system diagram |
| 3 | **Key Features, Methodology & Implementation Process** | Twelve shipped capabilities, one deterministic, explainable pipeline. | Architecture + prototype walkthrough |
| 4 | **Impact and Uses** | Communication is a measurable safety intervention, not a soft benefit. | Impact logic model + use-case matrix |
| 5 | **Impact and Uses** | Evidence today, a pilot design, a cost model, and a deployment path. | Evidence dashboard + pilot table |
| 6 | **Technology and Innovation** | Trustworthy AI at the edge — not a black box in the cloud. | Layered tech stack + innovation matrix |
| 7 | **Research and References** | Every clinical and technical claim is traceable. | Evidence hierarchy + citation map |

**One-line narrative for the whole deck**

> CareSpeak turns a patient's smallest voluntary movement — a finger, a blink, a gaze — into a spoken need, a prioritised alert, and a documented clinical action, while keeping the video on the device and the clinician in control.

---

## 0.1 Design system (use consistently)

| Element | Specification |
|---|---|
| Canvas | 16:9, 13.333 × 7.5 in (33.87 × 19.05 cm) |
| Margins | 0.6 in left/right, 0.5 in top/bottom |
| Grid | 12 columns; 3-column card layout for feature/impact slides |
| Heading font | Manrope ExtraBold or Inter Bold, 34–40 pt |
| Body font | Source Sans 3 or Inter Regular, 15–17 pt |
| Number font | JetBrains Mono Bold for statistics |
| Ink | `#0B1220` |
| Slate | `#1E293B` |
| Coral (primary accent) | `#C63A22` |
| Teal (clinical/success) | `#22A67E` |
| Amber (warning) | `#D97706` |
| Paper | `#F8FAFC` |
| Footer | `CareSpeak · SIH 2026 · slide n/7` + superscript citations |
| Rule | No slide has more than 3 colours plus ink/paper; no paragraph longer than 3 lines on-slide. |

**Citation convention.** Square brackets on the slide, e.g. `[1]`, map to Slide 7. The speaker notes carry the fuller explanation.

---

# Slide 1 — Problem Statement

**Kicker:** The care gap is not a data gap. It is a **translation gap**.

**Slide objective:** Make the judges feel the communication failure before showing a single line of technology.

## On-slide copy

### Problem Background

- **1 in 10** patients is harmed in health care, and **more than 3 million deaths a year** are linked to unsafe care; about **half of that harm is preventable** [1].
- In low- and middle-income countries, as many as **1 in 4** patients is harmed [1].
- **684,000** people die from falls each year; **37.3 million** falls are severe enough to need medical attention [2].
- About **1 million** Americans live with aphasia, and **~180,000** acquire it each year — most after a stroke [3].
- Deterioration is often preceded by abnormal vital signs. **NICE CG50** calls for track-and-trigger systems and clear escalation [4]; **NEWS2** standardises the trigger [5].
- Yet in many wards the patient's only channel is a **binary call bell**, the vitals are **episodic**, and the call outcome is **unstructured prose**.

### Issue Being Addressed

| Gap | What happens today | Consequence |
|---|---|---|
| **Expression gap** | A patient who cannot speak or move cannot say *what* hurts, *where*, or *how urgently*. | Unmet needs, distress, delayed help, preventable deterioration. |
| **Detection gap** | Observations are taken on rounds; between rounds there is no continuous picture. | Deterioration is found late, often after decompensation. |
| **Escalation gap** | Alarms are binary and context-free; staff suffer alert fatigue. | The loudest alarm wins, not the sickest patient. |
| **Continuity gap** | Calls and check-ins end as free-text notes; handover loses detail. | Repeated questions, missed follow-ups, no audit trail. |

### Target Users

- **Patients who cannot speak or move easily** — stroke and aphasia, ALS/MND, ICU and ventilated patients, post-operative patients, palliative care, older adults at risk of falls.
- **Front-line clinicians** — ward and ICU nurses, community nurses, on-call clinicians, nursing-home staff.
- **The care circle** — family caregivers, rural health workers, and quality/patient-safety teams.

## Visual

**Four-gap quadrant.** Centre: a simple patient icon with three channels (hand, eye, voice). Four surrounding quadrants labelled *Expression, Detection, Escalation, Continuity*. Each quadrant has one number and one consequence. Use coral for the gap, teal for the CareSpeak response (teased, not explained yet).

```
                    ┌──────────────────────────────┐
                    │  EXPRESSION GAP              │
                    │  "I can't say what I need"   │
                    └──────────────┬───────────────┘
                                   │
┌──────────────────┐      ┌────────▼────────┐      ┌──────────────────┐
│ DETECTION GAP    │      │     PATIENT     │      │ ESCALATION GAP   │
│ "No one sees me  │◄────►│  hand · eye ·   │◄────►│ "The loudest     │
│  between rounds" │      │     voice       │      │  alarm wins"     │
└──────────────────┘      └────────┬────────┘      └──────────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  CONTINUITY GAP              │
                    │  "The story is lost at       │
                    │   handover"                  │
                    └──────────────────────────────┘
```

**Build note:** Hero = four-gap quadrant. Put the three hard numbers as large stat callouts around it; target users as three chips along the bottom. Keep the full table in the speaker notes if the slide feels dense.

## Speaker notes (≈90 seconds)

> "Imagine you are awake, alert, and unable to speak. You know you need help. You can move one hand, or blink. The call bell is on the table, just out of reach. That is the moment CareSpeak is built for.
>
> The scale is not small. WHO estimates that one in ten patients is harmed in health care, and more than three million deaths a year are linked to unsafe care — about half of it preventable. Falls alone cause 684,000 deaths a year. Aphasia affects about a million people in the US, with 180,000 new cases a year, mostly after stroke.
>
> But the deeper problem is not away in a statistic. It is at the bedside. The patient cannot express. The nurse cannot see between rounds. The alarm has no context. And the story disappears at handover. Four gaps, one loop. That is what we built."

## Likely questions

**"Isn't this just an AAC app?"**
> No. AAC is one surface. The product closes a loop: on-device expression, continuous risk, context-aware escalation, and a structured record. The same brain also powers a browser care call and a low-cost wearable.

**"Why not use an existing communication board?"**
> Boards are static, low-bandwidth, and require a caregiver to be present. CareSpeak is dynamic, works with one hand or the eyes, speaks aloud, and streams the event to a nurse who may not be in the room.

**"Are these numbers about India?"**
> They are global WHO and US NIDCD figures, used conservatively to size the problem. The design target is Indian wards and home care, where shared devices and intermittent connectivity are the norm.

## Sources

[1] WHO patient-safety fact sheet · [2] WHO falls fact sheet · [3] NIDCD aphasia page · [4] NICE CG50 · [5] RCP NEWS2.

---

# Slide 2 — Proposed Solution

**Kicker:** From a blink to a bedside response — in one loop.

**Slide objective:** Show that CareSpeak is a system, not a feature list.

## On-slide copy

### Solution Overview

**One platform, three software surfaces, one clinical brain — plus a wearable.**

| Surface | Who uses it | What it does |
|---|---|---|
| **Bedside AAC** | Patient | Laptop/tablet camera reads hand gestures or eye movements and speaks the need aloud. Video never leaves the device. |
| **Nurse cockpit** | Nurse / clinician | Live signals, risk score with attribution, 15-minute forecast, messages, tasks, SBAR, audit trail. |
| **Remote care call** | Nurse + patient | Browser-to-browser voice check-in with live readings; the nurse portal's active session is used automatically; records are optional. |
| **IoT wearable** | Patient / ward | ESP32 + MAX30102 streams heart rate and SpO₂ and carries an SOS path; target BOM under ₹1,100 per bed. |

### Working Approach

1. **Sense.** MediaPipe runs in the browser: 21 hand landmarks or 478 facial landmarks including irises. The ESP32 wearable streams vitals. The care call uses WebRTC audio; the nurse's browser hosts the AI.
2. **Interpret.** Deterministic classifiers turn movement into a gesture, and eye geometry into a blink, gaze, or mouth event. A NEWS2-aligned additive risk engine scores 0–100; a damped Holt model projects 15 minutes ahead.
3. **Act.** The patient hears the need spoken aloud in their language. The nurse sees a prioritised card with the *reason* for the score, not just a number.
4. **Escalate.** Three HELP calls in 120 seconds, or alertness below 25% sustained for 30 seconds, create an escalation with an audit record. The nurse can acknowledge, escalate, or resolve.
5. **Record.** The care call produces a provenance-tagged transcript and a deterministic SBAR draft; the nurse reviews before anything is filed.

### Design rules

- **On-device by default** — the camera feed is processed in the browser; only landmark-derived events leave the device.
- **No diagnosis** — the system reports readings, thresholds, and trends; it never names a disease or prescribes.
- **Graceful degradation** — no model, no network, or no camera still leaves a usable, labelled fallback.
- **Explainable maths** — every risk point is attributed to a named factor with a clinical citation.
- **Consent and control** — the patient link is optional; live-only mode answers with readings, not history.

## Visual

**Closed-loop diagram** with five stations around a circle: *Sense → Interpret → Act → Escalate → Record*, and a return arrow labelled *feedback to patient*. Under it, a horizontal "example trace" strip:

```
DOUBLE BLINK  →  HELP (illustrative)  →  spoken "Help" + portal event
      →  risk 68: SpO₂ 30 + alertness 18 + repeated HELP 20
      →  nurse acknowledges  →  browser call  →  SBAR draft  →  audit entry
```

Use teal for the patient loop, coral for the clinician loop, slate for the record.

```
                          ┌─────────────────────┐
                          │   1. SENSE          │
                          │ hand · eye · voice  │
                          │ ESP32 · WebRTC      │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │   2. INTERPRET      │
                          │ classifiers · risk  │
                          │ forecast · intent   │
                          └──────────┬──────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
   ┌──────────▼──────────┐ ┌─────────▼─────────┐ ┌──────────▼─────────┐
   │ 3. ACT              │ │ 4. ESCALATE       │ │ 5. RECORD          │
   │ speech · messages   │ │ alert · call      │ │ transcript · SBAR  │
   │ portal cards        │ │ acknowledge       │ │ audit · export     │
   └──────────┬──────────┘ └─────────┬─────────┘ └──────────┬─────────┘
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │   FEEDBACK          │
                          │ "help is coming"    │
                          └─────────────────────┘
```

**Build note:** Left 55% = loop diagram; right 45% = example trace. Use one accent colour for the patient path and one for the clinician path. Keep the four-row surface table in the appendix if space is tight.

## Speaker notes (≈100 seconds)

> "Here is the whole product in one loop. A patient double-blinks. On the laptop, 478 facial landmarks become an eye-aspect-ratio event. The classifier requires nine consistent frames and a 430-millisecond hold, so a random blink does not trigger anything. The event becomes the word 'Help', spoken aloud, and a portal event.
>
> The nurse does not see a red dot. She sees a risk of 68, and next to it: oxygen saturation contributing 30, alertness 18, repeated HELP 20. She knows *why*. She acknowledges, calls the patient from the same browser, and the call writes a structured SBAR draft. The patient hears that help is coming.
>
> That is the loop: sense, interpret, act, escalate, record — and feedback. The camera never leaves the browser. The nurse never loses the reason behind the number."

## Likely questions

**"What happens if the internet is down?"**
> The bedside classifiers run on-device, and the PWA queues events in IndexedDB and flushes them on reconnect. The portal shows an honest connection state. Cloud is a convenience, not a dependency for expression.

**"What happens if the AI model is unavailable?"**
> The deterministic engine answers first. Gemini is optional and only used for open-ended phrasing; if it is missing or slow, the system falls back to record-grounded answers. Nothing fabricates a vital sign.

**"Why a browser call instead of a normal phone call?"**
> No media server, no PSTN cost, and the nurse's browser can host the AI and see live readings. The telephony stack remains a separate, unchanged mode for real phone lines.

## Sources

Repository: `README.md`, `README_CARE_WEB_CALL.md`, `README_VOICELINK.md`, `src/lib/risk.ts`, `src/lib/forecast.ts`, `src/lib/eyeClassifier.ts`, `src/lib/handClassifier.ts`. Clinical basis: [4], [5].

---

# Slide 3 — Key Features, Methodology & Implementation Process

**Kicker:** Twelve shipped capabilities. One deterministic pipeline.

**Slide objective:** Prove that the demo is a real system: features exist, the method is disciplined, and the prototype can be walked through live.

## On-slide copy

### A. Features (group into three columns)

**Patient-facing**

1. **Hand-gesture AAC** — 4 classified gestures (YES, NO, HELP, WATER with both hands) plus a 5-second open-palm clutch pause. MediaPipe tracks 21 landmarks; finger-extension ratios classify the pose; an 8-frame majority vote (75%) rejects flicker; a 500 ms hold ramps confidence.
2. **Eye/iris AAC** — 478 facial landmarks, including irises. Eye-aspect-ratio blink at **0.22**; gaze thresholds **0.04 / 0.05**; mouth-open **0.11**; 9-frame vote; 430 ms hold; double-blink window **700 ms**; 2 s HELP lock; per-user median+MAD calibration.
3. **Spoken output** — the need is spoken aloud. The bedside AAC supports **10 Indian languages**; the browser care call is deliberately **English-only** for clarity and safety.
4. **Offline-first PWA** — IndexedDB outbox, Background Sync, service worker, hidden-tab suspension. Expression keeps working when the network does not.

**Clinical intelligence**

5. **Live nurse portal** — Server-Sent Events with adaptive-poll fallback; acknowledge / escalate / resolve; per-bed cards; audit trail; natural stale-signal wording (“2 min ago”, not a raw timestamp).
6. **Risk engine** — additive, NEWS2-aligned, **0–100**; bands low `<20`, moderate `20–44`, high `45–69`, critical `≥70`. Components: HR 25/12, SpO₂ 30/18/8, alertness 30/18/8, blink 15/8, movement 12/8, repeated HELP up to 30, unresolved critical up to 25.
7. **Exact Shapley attribution** — because the score is additive, the Shapley value of factor *i* is exactly `φᵢ = componentᵢ(x) − componentᵢ(x₀)`. No sampling, no approximation; the invariant `baseValue + Σφᵢ = score` is test-asserted.
8. **15-minute forecast** — damped Holt double-exponential smoothing (`α=0.4`, `β=0.2`, `φ=0.85`), median-of-3 despiking, 2σ residual gate; clinical thresholds HR 50–120, SpO₂ 92%, alertness 40%, movement 5%.

**Platform**

9. **Browser care call** — the nurse portal's **active session is used automatically**; QR or 6-digit join; live readings; optional patient link; patient switching mid-call; SBAR.
10. **Grounded care assistant** — deterministic record answers first; optional Gemini Flash Lite for open questions; 24-hour content-hash cache; 25 symptom and red-flag patterns; depth `brief / standard / deep`; conversation memory.
11. **Low-cost wearable** — ESP32 + MAX30102; heart rate and SpO₂; SOS events retry until the server confirms; target BOM **under ₹1,100 per bed**.
12. **Security and audit** — scrypt password hashing; SHA-256 token hashes; `httpOnly`, `SameSite=Lax` session cookie; CSP and hardened headers; session-scoped access; formula-safe CSV export.

### B. Methodology (five phases)

| Phase | What we did | Artefact in the repo |
|---|---|---|
| **1. Clinical discovery** | Mapped ward, ICU, home-care and telephony workflows; defined non-goals (no diagnosis, no prescribing, no video upload). | `README.md`, `CARESPEAK_ARCHITECTURE_AUDIT.md` |
| **2. Deterministic modelling** | Turned guideline thresholds into pure functions with citations; wrote tests before UI. | `src/lib/risk.ts`, `forecast.ts`, `escalation.ts`, `clinicalBasis.ts` |
| **3. Edge implementation** | MediaPipe WASM; landmark ratios; calibration; temporal smoothing; confidence ramps. | `handClassifier.ts`, `eyeClassifier.ts`, `useEyeGesture.ts` |
| **4. Product integration** | Portal, SSE, care call, assistant, SBAR, reports, offline queue. | `src/app/care`, `src/lib/care/*`, 25 `/api/care/*` routes |
| **5. Validation** | 132 unit/integration tests, `tsc --noEmit`, `next build`, measured latency. | `tests/*`, `PERFORMANCE_REPORT.md` |

### C. Implementation process (flow)

```
Clinical guideline / workflow
        │
        ▼
Threshold table + citation  ──►  Pure function  ──►  Unit test
        │                                              │
        ▼                                              ▼
Edge calibration (MediaPipe)  ──►  Temporal smoothing  ──►  Confidence
        │
        ▼
Portal + SSE  ──►  Care call + assistant  ──►  Report + audit
        │
        ▼
Type-check  ──►  Test suite  ──►  Production build  ──►  Deploy
```

### D. Working prototype — 8-step demo

1. **Sign in** to the nurse portal at `/care`. The console puts the voice assistant first and shows the active session.
2. **Open the live session.** Six synthetic patients are available; the session is already linked to the active patient.
3. **Show the patient view** on a phone via QR or the 6-digit code. The pre-call context refreshes every 2 seconds.
4. **Trigger a gesture** (or simulate one). The portal receives the event; the patient hears the spoken word.
5. **Open the risk card.** Show the score, band, and the diverging attribution bars with citations.
6. **Start the browser call.** Speak or type a question; show the answer and the live readings. Switch the patient mid-call; show that the call continues and the context changes.
7. **Generate SBAR.** Show the deterministic draft, the provenance tags, and the copy button.
8. **End the session.** Show the report, the audit entry, and the open task/message created for follow-up.

**What to capture for the deck**

| Figure | What it proves | Capture instruction |
|---|---|---|
| Fig. 3.1 | System architecture | Architecture diagram below; rebuild as shapes or render at 2× and export PNG |
| Fig. 3.2 | Patient state machine | Diagram below; animate the happy path in the live demo |
| Fig. 3.3 | Implementation pipeline | Use the flow above as a horizontal SmartArt |
| Fig. 3.4 | Nurse cockpit | Screenshot at 1440 px wide, crop browser chrome |
| Fig. 3.5 | Phone view | Screenshot at 390 × 844; show live readings and call button |
| Fig. 3.6 | Risk attribution | Screenshot the diverging bar chart with citations visible |
| Fig. 3.7 | SBAR | Screenshot the draft with provenance tags |

## Visual

### Fig. 3.1 — System architecture

```
┌──────────────────────────── PATIENT BROWSER ────────────────────────────┐
│  Camera ──► MediaPipe WASM ──► Hand/Eye classifiers ──► speech output    │
│     │              21 / 478 landmarks              │                     │
│     │                                              ▼                     │
│  Mic ──► Web Speech / WebRTC ───────────────►  IndexedDB outbox          │
│                                                       │                  │
└───────────────────────────────────────────────────────┼──────────────────┘
                                                        │ HTTPS / SSE
┌───────────────────────────────────────────────────────▼──────────────────┐
│                         SERVERLESS (Next.js)                            │
│  Auth · sessions · join tokens · store driver (Redis / file / memory)    │
│  Care engine · risk · forecast · SBAR · optional Gemini · audit          │
└───────────────────────────────────────────────────────┬──────────────────┘
                                                        │ SSE / polling
┌───────────────────────────────────────────────────────▼──────────────────┐
│                          NURSE BROWSER                                  │
│  Live cards · risk attribution · forecast · messages · tasks · report    │
│  WebRTC call host · Web Speech · SBAR review · CSV export                │
└──────────────────────────────────────────────────────────────────────────┘
```

### Fig. 3.2 — Patient interaction state machine

```
IDLE ──camera ready──► TRACKING ──gesture/eye event──► CANDIDATE
  ▲                        │                              │
  │                        │ no face/hand                 │ 8–9 frame vote
  │                        ▼                              ▼
  └──── timeout ◄──── PAUSED                        CONFIRMED
                                                          │
                                                          │ 430–500 ms hold
                                                          ▼
                                                     SPEAK + SEND
                                                          │
                                                          ▼
                                                   COOLDOWN / IDLE
```

### Fig. 3.3 — Implementation pipeline

Use the five-phase table as a left-to-right chevron: *Discover → Model → Build edge → Integrate → Validate*. Under each chevron, one number: 5 gestures, 3 classifiers, 33 routes, 132 tests, 1 build.

**Build note:** Use a 3 × 4 card grid for the 12 features; a five-chevron strip for methodology along the bottom; three screenshots (portal, phone, SBAR) as a filmstrip. The 8-step demo and the seven figures belong in the speaker notes/appendix — do not put all seven on the slide.

## Speaker notes (≈2 minutes)

> "Slide 3 is the proof. There are twelve capabilities, but they are not twelve disconnected demos. They sit on one pipeline.
>
> Start at the patient. A hand is 21 landmarks. We do not classify a single frame; we take an eight-frame majority, and for holds we require half a second. That is why the demo does not fire on a scratch. The eye path is stricter: 478 landmarks, a nine-frame vote, a 430-millisecond hold, and a per-user calibration using median and MAD so a tilted camera does not look like a gaze.
>
> Then the clinical layer. The risk score is additive by design. Heart rate, oxygen, alertness, blink, movement, repeated HELP, unresolved alerts — each contributes a known weight. Because it is additive, the Shapley value is exact, not sampled. When a nurse asks 'why this score?', the answer is a list of points, not a heatmap.
>
> The forecast is deliberately simple: damped Holt, fifteen minutes ahead, with despiking and a noise gate. A nurse can ask 'why?' and get a one-line answer.
>
> The platform layer is where it becomes a product: the nurse portal, the browser call that reuses the active session, the grounded assistant, SBAR, the wearable, and the audit trail.
>
> The methodology is five phases. The important one is phase two: we wrote the clinical maths as pure functions and tested it before we built any UI. That is why we can show 132 passing tests and a clean production build."

## Likely questions

**"Why these exact thresholds?"**
> They are curated from NEWS2 and the clinical corpus in `clinicalBasis.ts`, and each factor carries a citation. They are decision-support thresholds, not diagnostic criteria. A production deployment would calibrate them with the local clinical team.

**"Why not use a deep-learning model for gestures?"**
> MediaPipe already gives robust landmarks; a small ratio-based classifier is faster, explainable, and testable. It runs on a school laptop without a GPU. We can swap in a learned classifier later without changing the event contract.

**"How do you stop false alarms?"**
> Temporal voting, hold times, cooldowns, per-user calibration, and a stale-signal policy that distinguishes “no signal” from “patient deteriorating”. The nurse can also acknowledge or resolve, which feeds the audit trail.

**"Is the demo using real patient data?"**
> No. All six patients and fifteen records are synthetic and flagged `synthetic: true`. The UI says so.

## Sources

Repository: `README.md`, `src/lib/*`, `tests/*`, `PERFORMANCE_REPORT.md`, `docs/CARE_WEB_CALL_DEPLOYMENT.md`. Clinical basis: [4], [5].

---

# Slide 4 — Impact and Uses

**Kicker:** Communication is a safety intervention.

**Slide objective:** Move the judges from "nice demo" to "this changes outcomes and fits real workflows".

## On-slide copy

### Expected Impact

| Stakeholder | Before CareSpeak | With CareSpeak | Indicator to measure |
|---|---|---|---|
| **Patient** | Waits for someone to notice; cannot explain what is wrong. | Expresses a need with one hand or a blink; hears confirmation. | Time-to-express; unmet needs per shift; distress episodes. |
| **Nurse** | Alarm-driven rounds; context lives in their head. | Prioritised by risk **and reason**; can check in remotely. | Response time; alerts per shift; time on documentation. |
| **Ward / ICU** | Episodic observations; deterioration found late. | Continuous trend + 15-minute forecast + escalation. | Time-to-escalation; avoidable deterioration events. |
| **Family / caregiver** | Phone updates with no structure. | Structured update + SBAR; fewer repeated questions. | Caregiver confidence; repeat calls. |
| **Health system** | Manual audit; incident reconstruction is slow. | Immutable audit trail; exportable reports. | Review time; audit completeness. |

**Design targets — clearly labelled as targets, not results**

| Metric | Target | Why this target |
|---|---|---|
| Gesture-to-speech | **< 1 s** | 30 FPS inference + 8-frame vote ≈ 270 ms; 500 ms hold for hold gestures. |
| Eye event to speech | **< 1 s** | 9-frame vote + 430 ms hold. |
| Alert delivery on LAN | **< 1 s** | SSE push; 500 ms reconciliation. |
| Browser-call first audio | **1.5–2.5 s** | Measured best 1.5 s; typical 2.5–6 s on a contended CPU. |
| Nurse triage decision | **< 60 s** | Risk + attribution + trend on one screen. |

### Real-World Uses

| Setting | User | CareSpeak mode | Value |
|---|---|---|---|
| **ICU / ventilated** | Patient + ICU nurse | Eye mode + portal | Expression without voice or hand movement. |
| **Stroke rehabilitation** | Patient + therapist | Hand/eye + speech | Repetition with agency; progress visible. |
| **ALS / MND at home** | Patient + caregiver | Eye gaze + wearable | Independence between visits. |
| **Post-operative ward** | Patient + ward nurse | Hand + call + vitals | Fast help without reaching for a bell. |
| **Heart failure / COPD at home** | Community nurse | Browser call + records + SBAR | Structured check-in, not a vague phone call. |
| **Nursing home / fall risk** | Care staff | Wearable + alertness/movement | Night-time safety and earlier review. |
| **Rural / low-connectivity** | Community health worker | Offline-first PWA | Works when the network does not. |
| **Quality improvement** | Patient-safety team | Audit + export | Measure communication and response. |

## Visual

**Impact logic model** (five chevrons):

```
INPUTS              ACTIVITIES              OUTPUTS                 OUTCOMES                IMPACT
Camera + wearable → classify + score   →   spoken need + alert  →  faster response      →  safer care
Clinical record  → ground + forecast   →   risk reason + SBAR   →  better handover      →  fewer missed needs
Nurse time       → prioritise + call   →   audit + report       →  less documentation   →  more time at bedside
```

**Use-case matrix** (2 × 4): rows *hospital / home*, columns *communication / monitoring*. Place each use case in a cell. This visually proves breadth without a wall of text.

**Build note:** Left = impact table (5 rows); right = 2 × 4 use-case matrix. Put the logic model as a thin chevron strip along the bottom. Use the Anita/Lakshmi story only in the speaker notes, not as slide text.

## Speaker notes (≈100 seconds)

> "Impact starts with one person. A patient who can signal 'help' is not just more comfortable; they are safer. The literature on falls and deterioration says the same thing: delay is the enemy.
>
> For the nurse, the impact is attention. Instead of a wall of alarms, she gets a ranked list with the reason. Instead of walking to the room to ask a question, she can open a browser call and see the readings while she talks.
>
> For the ward, the impact is memory. The audit trail and the SBAR mean the next shift does not start from zero.
>
> The demo data shows this end to end. Anita is a 68-year-old with heart failure. Her home weights rose from 71.2 to 74.1 kilograms in a week; she reported ankle swelling and needing an extra pillow. That seeded call is escalated, a task is created to call her back, and a message tells her to weigh herself daily. Lakshmi is a diabetes patient with dizziness and a near-fall; her check-in is escalated and her report is still unreviewed. Those are exactly the two workflows a ward actually needs: close the loop, and do not lose the open one.
>
> The targets on this slide are design targets, not clinical results. Slide 5 shows what we have actually measured."

## Likely questions

**"What is the single strongest impact claim you can defend today?"**
> Engineering: a working, tested, on-device loop with measured latency. Clinically, we can defend the *mechanism* — faster expression, context-rich escalation, structured handover — but not yet patient outcomes. That is what the pilot on Slide 5 is for.

**"Who pays?"**
> In a public hospital, the device is a laptop or tablet that already exists; the wearable is under ₹1,100 per bed; the software is MIT-licensed. The main cost is training and support. Slide 5 gives an indicative model.

**"Does this replace nurses?"**
> No. It replaces the patient's silence and the nurse's blind spots. The nurse remains the decision-maker; the system escalates to a human.

## Sources

Repository demo data: `src/lib/care/seedPatients.ts`, `src/lib/care/seedDemo.ts`. Clinical basis: [1]–[5].

---

# Slide 5 — Impact and Uses

**Kicker:** Evidence today. A pilot design for tomorrow.

**Subtitle:** Same impact story, different lens: **evidence, validation, cost, scale, deployment.**

**Slide objective:** Answer the three questions a serious judge asks: *Does it work? Will it scale? Can it be deployed safely?* — without overclaiming clinical benefit.

> **Differentiation from Slide 4.** Slide 4 explains *why it matters*. Slide 5 proves *what is actually verified*, shows the *validation plan*, and gives the *cost, scale, and deployment* path. Keep the same two headings — **Expected Impact** and **Real-World Uses** — but do not repeat the use-case list.

## On-slide copy

### Expected Impact

#### Evidence dashboard — what is verified today

| Layer | Evidence | Status |
|---|---|---|
| **Engineering** | 132/132 tests passing; `tsc --noEmit` clean; `next build` succeeds; 33 route handlers; ~31k lines across 152 source/test files. | **Verified at HEAD `cd9941b`** |
| **Speech performance** | ASR **448–621 ms** (median ≈475 ms); TTS real-time factor **0.168–0.392**; LLM first token **63–245 ms** warm; first spoken audio **1.5 s best, 2.5–6 s typical** on a contended CPU. | **Measured**, one laptop, CPU-only |
| **Reliability** | SSE `Last-Event-ID` resume; per-connection dedupe; idempotent writes; IndexedDB outbox; adaptive polling fallback. | **Implemented + unit-tested** |
| **Security** | scrypt password hashing; SHA-256 token hashes; `httpOnly`, `SameSite=Lax` cookie; CSP; `Permissions-Policy`; session-scoped access. | **Implemented + reviewed** |
| **Demo data** | 6 synthetic patients, 15 synthetic records, 2 seeded sessions, 2 tasks, 2 messages; every record flagged `synthetic: true`. | **Verified** |
| **Clinical benefit** | No prospective trial, no regulatory clearance, no clinical endpoint. | **Not yet validated — stated openly** |

#### Validation plan — a feasible pilot, not a fantasy trial

**Design (proposed):** prospective, single-site, mixed-methods feasibility study.

| Element | Plan |
|---|---|
| Setting | 2 inpatient wards (1 general, 1 high-acuity) + 1 home-care cohort |
| Duration | 8 weeks of fieldwork (2-week baseline + 4-week deployment + 2-week post); 12 weeks including setup and analysis |
| Participants | 30 patients (stroke/aphasia, post-op, COPD/heart failure, older adults at fall risk) + 12 nurses |
| Exposure | Bedside AAC + nurse portal; browser care call for the home cohort |
| Comparator | Usual care, pre/post with a 2-week baseline |
| Primary endpoint | **Feasibility**: recruitment, retention, device uptime, task completion |
| Secondary endpoints | Time-to-express; nurse response time; alert precision; documentation time; SUS; adverse events |
| Analysis | Descriptive statistics; paired pre/post; thematic analysis of interviews |
| Ethics | Written consent or consultee advice; DPDP-aligned data minimisation; no video stored; withdrawal without penalty |

**Pre-specified targets (not results)**

| KPI | Target | Rationale |
|---|---|---|
| System usability (SUS) | **≥ 75** | Industry threshold for "good" usability. |
| Task success (patient completes a need) | **≥ 90%** | The core promise must be reliable. |
| Time-to-express | **< 30 s** | Faster than waiting for a round. |
| False activation rate | **< 1 per hour** | Low enough for trust, high enough to be honest. |
| Alert precision (actionable / total) | **≥ 70%** | Reduces alarm fatigue. |
| Nurse response time | **−20% vs baseline** | The loop must close faster. |
| Documentation time | **−30% vs baseline** | SBAR + structured report should save time. |
| Serious device-related adverse events | **0** | Non-negotiable safety gate. |

#### Cost model — indicative, not a quotation

| Item | Basis | 50-bed pilot (estimate) |
|---|---|---|
| Wearable per bed | ESP32 + MAX30102, target BOM | **₹1,100 × 50 = ₹55,000** one-time |
| Software licence | MIT-licensed repository | **₹0** |
| Inference | Local models by default; an optional Gemini key is not required for the demo | **₹0** runtime on the default path |
| Hosting + Redis | Vercel + Upstash free/hobby tier for demo; production plan for commercial use | **₹0–₹8,000 / month** |
| Training + support | 2 sessions + floor support | **₹40,000–₹60,000** one-time |
| **Total, first 8 weeks** | Hardware + training + hosting | **≈ ₹0.95–1.3 lakh** |
| **Marginal cost per additional bed** | Wearable only | **≈ ₹1,100** one-time |

> These are planning estimates built from the repo's BOM target and current free-tier limits, not vendor quotes. A real deployment must price support, device management, and clinical training.

### Real-World Uses

#### Scalability — why it reaches beyond one ward

- **Stateless route handlers** — any Vercel instance can serve any request.
- **Redis-backed state** — sessions, transcripts, signalling, and reports survive instance changes; append-only lists for events.
- **SSE + polling fallback** — no sticky sessions required for correctness.
- **Driver abstraction** — `redis` for production, `file` for local, `memory` for tests; the UI reports which one is active.
- **Horizontal path** — shard by hospital/region; keep the same event contract; move to a managed Redis cluster when needed.
- **On-prem path** — Node + Redis behind a reverse proxy, no external egress; suitable for hospitals that cannot use a public cloud.

#### Deployment in five steps

```bash
# 1. Install and configure
npm ci
cp .env.example .env.local

# 2. Set the production store
# CARE_STORE=redis
# UPSTASH_REDIS_REST_URL=...
# UPSTASH_REDIS_REST_TOKEN=...

# 3. Set nurse credentials (never ship the demo default)
# CARE_NURSE_USER=...
# CARE_NURSE_PASS=...
# CARE_SEED_DEMO=false

# 4. Build and verify
npm run build

# 5. Deploy
vercel deploy --prod
```

#### Post-deploy checks

1. The header shows **persistent** storage, not the red “NOT persistent” warning.
2. Two browser tabs see the same session within one second.
3. A phone joins by QR and by 6-digit code.
4. The patient view shows live readings; the portal shows the same values.
5. Ending the session produces a report and an audit entry.
6. A second instance/region can read the same session (Redis path).

#### Security and privacy checklist

- Video is processed in the browser; only landmark-derived events are transmitted.
- Join tokens are random 32-byte values; only their SHA-256 hash is stored.
- Nurse sessions are opaque, `httpOnly`, `SameSite=Lax`, and expire after 8 hours.
- CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` are set.
- Demo data is synthetic and clearly labelled; production seeding is disabled with `CARE_SEED_DEMO=false`.
- For India, design to the **DPDP Act 2023** principles: purpose limitation, data minimisation, consent, retention, and grievance redress. For US/EU deployments, add HIPAA/GDPR review before any real patient data.

## Visual

**Evidence dashboard** — four quadrants: *Verified / Measured / Implemented / Not yet validated*. Put the numbers in the first three; put the honest gap in the fourth in amber.

**Pilot timeline** — a 12-week Gantt:

```
Weeks 1–2   Ethics + site setup + training
Weeks 3–4   Baseline (usual care)
Weeks 5–8   Deployment + weekly review
Weeks 9–10  Post-deployment + interviews
Weeks 11–12 Analysis + report + go/no-go
```

**Scale ladder** — 1 ward → 2 wards → 50 beds → 500 beds → 5,000 beds, with the same three invariants: stateless routes, Redis state, SSE contract.

**Build note:** Two columns — left = **Expected Impact** (evidence summary + pilot timeline), right = **Real-World Uses** (scale ladder + deployment steps). Move the full cost table to the appendix if the slide is dense; keep the headline numbers (₹1,100/bed, ₹0 licence, 132 tests) on-slide.

## Speaker notes (≈2 minutes)

> "This is the slide where we separate what we have earned from what we have not.
>
> What we have earned: a working system, 132 passing tests, a clean type-check, a production build, 33 route handlers, and measured speech latency. The speech recognition runs in 448 to 621 milliseconds on this laptop. The text-to-speech is about six times faster than real time at its best, and still 2.5 times faster at its worst. The language model's first token is 63 to 245 milliseconds when warm. The first spoken audio in a live call is about 1.5 seconds at best, and 2.5 to 6 seconds on a busy CPU. Those are honest numbers from a contended laptop, not a data-centre benchmark.
>
> What we have not earned: a clinical trial, a regulatory clearance, or a claim that this reduces falls or deaths. We are not going to pretend otherwise. What we do have is a feasible pilot design: two wards, thirty patients, twelve nurses, eight weeks, with feasibility as the primary endpoint and safety as a hard gate.
>
> The cost model is deliberately simple. The wearable is under eleven hundred rupees per bed. The software is MIT-licensed. Inference is local. The main cost is training and support, not licences. At fifty beds, the first eight weeks are about one to one-point-two lakh rupees, and every additional bed is about eleven hundred rupees of hardware.
>
> Scale is an architecture property, not a promise. Stateless routes, Redis state, SSE with polling fallback, and a driver abstraction. It runs on Vercel for the demo, and on-premise for a hospital that cannot use a public cloud."

## Likely questions

**"132 tests — what do they cover?"**
> Classifiers, risk and Shapley invariants, forecast, escalation, portal brain, care domain, voice parsing, store, and analytics. They are unit/integration tests, not clinical validation.

**"Why only 30 patients?"**
> It is a feasibility study, not a powered efficacy trial. Thirty patients and twelve nurses are enough to measure recruitment, uptime, task success, and workflow fit before committing to a larger trial.

**"What is the biggest deployment risk?"**
> Not the model — the workflow. Device charging, camera placement, nurse training, and consent are the hard parts. That is why the pilot measures uptime and task completion first.

**"What about data protection?"**
> Data minimisation is architectural: video never leaves the browser. Tokens are hashed. Demo data is synthetic. A real deployment needs a DPDP/HIPAA review and a retention policy before go-live.

## Sources

Repository: `PERFORMANCE_REPORT.md`, `HARDWARE_REPORT.md`, `SECURITY.md`, `docs/CARE_WEB_CALL_DEPLOYMENT.md`, `src/lib/care/store.ts`, `tests/*`. Policy: DPDP Act 2023 [14]. Clinical basis: [4], [5].

---

# Slide 6 — Technology and Innovation

**Kicker:** Trustworthy AI at the edge — not a black box in the cloud.

**Slide objective:** Show technical depth and a defensible reason why this is innovative, not just a stack list.

## On-slide copy

### Tools, Frameworks and Platforms

| Layer | Technology | Role | Why this choice |
|---|---|---|---|
| **Frontend** | Next.js 15, React 19, TypeScript, Tailwind CSS 4 | Portal, patient view, PWA | One codebase, server routes, strong typing. |
| **Motion / charts** | Framer Motion, Recharts, lucide-react | Transitions, risk attribution, icons | Fast, accessible, no heavy chart runtime. |
| **Vision** | MediaPipe Tasks Vision 0.10.18 (WASM) | 21 hand + 478 face landmarks | On-device, no video upload, ~30 FPS cap. |
| **Speech** | Web Speech API, SpeechSynthesis, AudioWorklet | Patient ASR/TTS, call audio | Native browser, no per-minute API. |
| **Realtime** | WebRTC, Server-Sent Events, fetch fallback | Call media, live portal | P2P media, optional TURN relay; serverless-friendly signalling. |
| **Offline** | IndexedDB, Background Sync, Service Worker | Outbox, cache, offline shell | Zero-data-loss in low connectivity. |
| **Server** | Next.js route handlers, Node crypto | Auth, sessions, reports | Stateless, deployable to Vercel or on-prem. |
| **State** | Upstash Redis REST; file/memory drivers | Sessions, events, transcripts | Multi-instance safe; honest fallbacks. |
| **AI** | Deterministic engine + optional Gemini Flash Lite | Grounded answers, phrasing | Deterministic first; LLM only when needed. |
| **VoiceLink stack** | FastAPI, whisper.cpp, Ollama `qwen2.5:3b`, sherpa-onnx VITS, Silero VAD | Local voice line | Zero-cost, local, measurable. |
| **Hardware** | ESP32, MAX30102 | Vitals + SOS | Under ₹1,100 BOM, Wi-Fi/BLE. |
| **Quality** | Vitest, `tsc --noEmit`, `next build` | Tests, types, production build | Catch regressions before demo. |

### What Makes It Innovative

| # | Innovation | Why it is different | Proof in the repo |
|---|---|---|---|
| 1 | **On-device multimodal AAC** | Hand + eye + voice in one browser surface; video never uploaded. | MediaPipe WASM; `handClassifier.ts`; `eyeClassifier.ts`; `browserAI.ts` |
| 2 | **Exact Shapley explainability** | Additive clinical score means exact Shapley values, not sampled approximations. | `risk.ts`; test-asserted `Σφᵢ = score` |
| 3 | **Explainable forecast** | Damped Holt with despiking and a noise gate; every alert has a reason. | `forecast.ts`; thresholds + reasons |
| 4 | **Deterministic-first assistant** | Record-grounded answers are the default; the LLM is optional and cached. | `portalBrain.ts`; 24h cache; fallback |
| 5 | **Serverless browser care call** | No media server; the nurse's browser hosts the AI; active session auto-used. | WebRTC + `/api/care/*`; `README_CARE_WEB_CALL.md` |
| 6 | **Live-only privacy mode** | An unlinked session answers with readings only, not history. | `portalBrain.ts` unlinked branch |
| 7 | **Offline-first, exactly-once** | IndexedDB outbox + SSE resume + idempotent writes. | `store.ts`; sync hooks; tests |
| 8 | **Low-cost IoT** | Clinical telemetry at a BOM under ₹1,100 per bed. | `firmware/carespeak_esp32.ino`; `HARDWARE_REPORT.md` |
| 9 | **Provenance by design** | Every fact tagged `record`, `patient`, or `ai`; SBAR is deterministic. | `types.ts`; `report.ts`; SBAR builder |
| 10 | **Accessibility + multilingual** | 10 Indian languages in AAC; aria-live; keyboard-friendly controls. | `i18n.ts`; UI components |

### Differentiation

| Capability | Typical AAC prototype | Typical remote monitoring | Typical telehealth | **CareSpeak** |
|---|---|---|---|---|
| Video stays on device | Often cloud | n/a | n/a | **Yes** |
| Hand + eye + voice | Partial | No | No | **Yes** |
| Explainable risk (exact attribution) | No | Score only | No | **Yes** |
| Care call + live readings + record | No | Separate product | Video only | **Yes** |
| Works offline | No | No | No | **Yes** |
| Cost model | Proprietary device | Subscription | Per consult | **< ₹1,100 device + OSS licence** |

> The comparison is against the *general pattern* of prototypes and product classes, not a benchmark of named vendors. The point is architectural: communication, monitoring, and escalation are one loop.

## Visual

**Layered stack diagram** (bottom to top):

```
┌─────────────────────────────────────────────────────────────┐
│  EXPERIENCE   patient AAC · nurse cockpit · browser call     │
├─────────────────────────────────────────────────────────────┤
│  CLINICAL     risk · forecast · escalation · SBAR · audit    │
├─────────────────────────────────────────────────────────────┤
│  INTELLIGENCE MediaPipe · classifiers · deterministic engine │
│               optional Gemini · 24h cache                    │
├─────────────────────────────────────────────────────────────┤
│  REALTIME     WebRTC · SSE · IndexedDB outbox · PWA          │
├─────────────────────────────────────────────────────────────┤
│  PLATFORM     Next.js routes · Redis/file/memory · auth      │
├─────────────────────────────────────────────────────────────┤
│  HARDWARE     ESP32 + MAX30102 · camera · mic · speaker      │
└─────────────────────────────────────────────────────────────┘
```

**Innovation spotlight:** a 2 × 2 matrix with axes *on-device ↔ cloud* and *single signal ↔ multimodal*, placing CareSpeak in the top-left (on-device, multimodal) and typical prototypes in the other quadrants.

**Build note:** Left = six-layer stack diagram; right = 2 × 2 innovation spotlight. Keep the 12-row technology table in the appendix; on-slide show only the six layers and the six differentiating capabilities.

## Speaker notes (≈2 minutes)

> "The stack is deliberately boring where boring is good. Next.js, React, TypeScript, Tailwind — a team can maintain it. MediaPipe for vision, because it is fast and runs in the browser. Redis for state, because serverless functions do not share memory. None of that is the innovation.
>
> The innovation is the architecture of trust. First, the video never leaves the device. Second, the clinical maths is additive, so the Shapley explanation is exact, not a sampled approximation. Third, the assistant is deterministic first: it answers from the record, and only uses a language model for open-ended phrasing, with a cache and a local fallback. Fourth, the care call is serverless: the nurse's browser is the AI host, and the session is already active, so there is no ‘choose a person’ step.
>
> The wearable is the physical edge: an ESP32 and a MAX30102, under eleven hundred rupees, with SOS retries until the server confirms. That is how you get vitals in a ward that cannot afford a monitor per bed.
>
> The comparison table is not an attack on vendors. It is a statement of category: most products do one of communication, monitoring, or telehealth. CareSpeak closes the loop across all three."

## Likely questions

**"Why MediaPipe rather than a custom model?"**
> It gives robust 21/478 landmarks on CPU/WASM, with a small integration surface. Our innovation is the temporal logic and the clinical loop, not retraining a landmark model.

**"Why Gemini at all?"**
> Only for open-ended phrasing the deterministic engine cannot cover. It is optional, server-side, cached for 24 hours, and never allowed to invent vitals. With no key, the product still works.

**"Why not a native app?"**
> A browser removes installation, works on shared ward devices, and supports the PWA offline model. The trade-off is browser speech variability, which we handle with preferred voices and graceful fallback.

**"What is the moat?"**
> The clinical loop and the evidence discipline: exact attribution, provenance, audit, and a deployment model that works on-prem or serverless. A model is copyable; a trusted workflow is not.

## Sources

Repository: `package.json`, `src/lib/*`, `src/app/api/*`, `README_VOICELINK.md`, `PERFORMANCE_REPORT.md`, `HARDWARE_REPORT.md`. Technical basis: [6]–[13].

---

# Slide 7 — Research and References

**Kicker:** Every clinical number is traceable.

**Slide objective:** Close the credibility loop. Show that the thresholds, algorithms, and standards are grounded — and state the limits of the evidence.

## On-slide copy

### Evidence hierarchy

```
Clinical guidelines  ──►  thresholds, escalation, non-goals
Peer-reviewed methods ──►  landmarks, blink detection, Shapley, forecasting
Open standards       ──►  WebRTC, Service Workers, IndexedDB
Project measurements ──►  latency, tests, build, hardware
```

### References

**Clinical guidelines and patient-safety evidence**

[1] World Health Organization. *Patient safety* (fact sheet). Geneva: WHO. https://www.who.int/news-room/fact-sheets/detail/patient-safety — accessed 9 Nov 2026.

[2] World Health Organization. *Falls* (fact sheet). Geneva: WHO. https://www.who.int/news-room/fact-sheets/detail/falls — accessed 9 Nov 2026.

[3] National Institute on Deafness and Other Communication Disorders (NIDCD). *Aphasia*. Bethesda, MD: NIH. https://www.nidcd.nih.gov/health/aphasia — accessed 9 Nov 2026.

[4] National Institute for Health and Care Excellence. *Acutely ill adults in hospital: recognising and responding to deterioration*. Clinical guideline CG50. London: NICE, 2007. https://www.nice.org.uk/guidance/cg50

[5] Royal College of Physicians. *National Early Warning Score (NEWS) 2: Standardising the assessment of acute-illness severity in the NHS*. London: RCP, 2017. https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/

**Algorithms and methods**

[6] Lugaresi C, Tang J, Nash H, et al. *MediaPipe: A Framework for Building Perception Pipelines*. arXiv:1906.08172, 2019. https://arxiv.org/abs/1906.08172

[7] Soukupová T, Čech J. *Real-time eye blink detection using facial landmarks*. Proc. 21st Computer Vision Winter Workshop (CVWW), 2016.

[8] Lundberg SM, Lee S-I. *A Unified Approach to Interpreting Model Predictions*. Advances in Neural Information Processing Systems 30 (NeurIPS), 2017. https://arxiv.org/abs/1705.07874

[9] Holt CC. *Forecasting trends and seasonals by exponentially weighted moving averages*. Office of Naval Research Memorandum No. 52, 1957.

[10] Gardner ES Jr, McKenzie E. *Forecasting trends in time series*. Management Science 31(10):1237–1246, 1985. DOI: 10.1287/mnsc.31.10.1237

[11] Stern JA, Boyer D, Schroeder D. *The eye blink as a criterion of fatigue and cognitive state*. Human Factors 36(2):285–297, 1994.

[12] Karson CN. *The eye blink, psychiatric conditions, and dopamine*. Biological Psychiatry 18(3):371–395, 1983.

**Standards, security, and platforms**

[13] W3C. *Service Workers* (specification). https://www.w3.org/TR/service-workers/

[14] W3C. *IndexedDB* (specification). https://www.w3.org/TR/IndexedDB/

[15] IETF. *RFC 8825: Overview of WebRTC*. https://www.rfc-editor.org/rfc/rfc8825

[16] Government of India. *Digital Personal Data Protection Act, 2023* (Act 22 of 2023). https://www.meity.gov.in/data-protection-framework

[17] U.S. Department of Health & Human Services. *HIPAA*. https://www.hhs.gov/hipaa/index.html

[18] Espressif Systems. *ESP32 series datasheet*; Analog Devices. *MAX30102 datasheet*. https://www.espressif.com/en/products/socs/esp32 · https://www.analog.com/en/products/max30102.html

**Project evidence (internal, versioned)**

[19] CareSpeak repository. `README.md`, `README_CARE_WEB_CALL.md`, `README_VOICELINK.md`, `PERFORMANCE_REPORT.md`, `HARDWARE_REPORT.md`, `SECURITY.md`, `CARESPEAK_ARCHITECTURE_AUDIT.md`, `ZERO_COST_POLICY.md`, `docs/REFERENCES.md`.

[20] CareSpeak test suite. `tests/*.test.ts` — 11 files, 132 passing tests at HEAD `cd9941b`; `tsc --noEmit` clean; `next build` succeeds.

### How each source was used

| Source | What it informed | Where it appears |
|---|---|---|
| [1] WHO patient safety | Problem scale; preventability | Slide 1 |
| [2] WHO falls | Fall burden; older-adult target | Slide 1 |
| [3] NIDCD aphasia | Stroke/aphasia target; communication barrier | Slide 1 |
| [4] NICE CG50 | Track-and-trigger; escalation | Slide 1, risk/escalation |
| [5] RCP NEWS2 | Vital-sign weights; response thresholds | `risk.ts`, `clinicalBasis.ts` |
| [6] MediaPipe | 21/478 landmarks; on-device inference | `handClassifier.ts`, `eyeClassifier.ts` |
| [7] Soukupová & Čech | Eye-aspect-ratio blink logic | `eyeClassifier.ts` |
| [8] Lundberg & Lee | Shapley attribution | `risk.ts` |
| [9], [10] Holt / Gardner–McKenzie | Damped trend forecast | `forecast.ts` |
| [11], [12] Blink literature | Blink baseline and abnormality bands | `clinicalBasis.ts` |
| [13]–[15] W3C/IETF | Offline, storage, WebRTC | PWA, care call |
| [16], [17] DPDP/HIPAA | Privacy and deployment checklist | Slide 5, `SECURITY.md` |
| [18] ESP32/MAX30102 | Wearable BOM and telemetry | `firmware/`, `HARDWARE_REPORT.md` |
| [19], [20] Repo evidence | Measured latency; tests; architecture | Slides 3, 5, 6 |

### Claims discipline

| Claim | Status | Evidence |
|---|---|---|
| Video never leaves the device | **Verified** | MediaPipe WASM in browser; no upload path |
| Sub-second speech recognition | **Measured** | 448–621 ms on test laptop |
| Exact Shapley attribution | **Verified by test** | `Σφᵢ = score` invariant |
| Works offline | **Implemented, not field-tested** | IndexedDB outbox + service worker |
| Reduces falls or deterioration | **Not claimed** | No clinical trial |
| Regulatory approval | **Not claimed** | No clearance |
| Real PSTN calls | **Not claimed for the demo** | Browser-to-browser; telephony is a separate mode |
| Clinical-grade accuracy | **Not claimed** | Prototype thresholds; local calibration required |

### Limitations (state them before the judges do)

- **Synthetic data only.** Six patients and fifteen records are fabricated for the demo; no real patient data is used.
- **Single-machine latency.** Measured on one contended laptop, CPU-only; no GPU claim.
- **Browser variability.** Web Speech and SpeechSynthesis differ across Chrome, Edge, and Safari; the app selects preferred voices and falls back gracefully, but voice quality is device-dependent.
- **No clinical validation.** The pilot on Slide 5 is a design, not a result.
- **No regulatory clearance.** A production path requires DPDP/HIPAA review and, if marketed as a medical device, the applicable regulatory pathway.
- **Telephony limits.** Real PSTN calls require an upgraded provider and verified numbers; the current demo is browser-to-browser.
- **Pairing dependency.** A bare `/care/phone` cannot know the nurse's session; the patient must join by QR, 6-digit code, or an explicit `?session=` link.
- **Persistence requirement.** Multi-instance deployment requires Redis; file/memory drivers are for local development and tests only.

## Visual

**Evidence hierarchy pyramid** — four bands: *Guidelines* (base), *Peer-reviewed methods*, *Standards*, *Project measurements* (top). Add a side arrow: "claims move up only when evidence moves up".

**Citation map** — a small matrix: slides 1–7 on the x-axis, references 1–20 on the y-axis; dots show which slide uses which source. This is visually impressive and proves traceability.

**Build note:** Two-column reference list; bottom = citation map (slides 1–7 × refs 1–20). Keep the limitations in the speaker notes; put the claims-discipline table on-slide in amber.

## Speaker notes (≈90 seconds)

> "We did not invent the clinical thresholds. We curated them. NEWS2 gives us the vital-sign weighting; NICE CG50 gives us the escalation principle; WHO gives us the scale of the problem; NIDCD gives us the aphasia population.
>
> We did not invent the algorithms either. MediaPipe gives us the landmarks. Soukupová and Čech give us the eye-aspect-ratio method. Lundberg and Lee give us Shapley values. Holt and Gardner–McKenzie give us the damped trend. What we built is the integration: a loop that turns those methods into a bedside action.
>
> The last two references are the most important for a hackathon: our own repository and our own tests. 132 passing tests, a clean type-check, a production build, and measured latency. That is the evidence we can defend today.
>
> And this slide is also where we say what we have not proven. No clinical trial. No regulatory clearance. No claim that this reduces falls or deaths yet. We would rather state that clearly than oversell."

## Likely questions

**"Why cite WHO rather than Indian data?"**
> WHO gives a conservative, globally comparable baseline. The Indian deployment case needs local epidemiological and workflow data, which is exactly what the pilot would collect.

**"Are the thresholds clinically validated?"**
> They are curated from published guidance and encoded with citations, but they are decision-support thresholds, not diagnostic criteria. Local calibration and clinician review are required before clinical use.

**"What is the strongest peer-reviewed basis?"**
> MediaPipe for landmarks, EAR for blink detection, Shapley for attribution, and damped Holt for forecasting. Each maps to a specific module, not a vague inspiration.

## Sources

All references above. Internal evidence: `docs/REFERENCES.md`, `PERFORMANCE_REPORT.md`, `tests/*`.

---

# Appendix A — 90-second demo script

Use this if the judges ask for a live walkthrough and time is short.

| Time | Action | What to say |
|---|---|---|
| 0:00–0:10 | Open `/care`; show the active session. | "The nurse portal already knows the session. No patient picker." |
| 0:10–0:25 | Show the patient view on the phone via QR. | "The phone refreshes context every two seconds; live readings every ten." |
| 0:25–0:40 | Trigger a gesture; show the spoken word and portal event. | "The camera never leaves the device; only the event does." |
| 0:40–0:55 | Open the risk card; point to the attribution bars. | "This is not a black-box score. Every point has a reason and a citation." |
| 0:55–1:10 | Start the browser call; ask a question; switch patient. | "The call continues while the context switches. The record link is optional." |
| 1:10–1:25 | Generate SBAR; show provenance tags. | "Deterministic, record-grounded, nurse-reviewed." |
| 1:25–1:30 | End session; show audit entry. | "The loop closes with a record, not a memory." |

**Demo fallback:** if the camera or microphone fails, use the seeded demo sessions and the text input. The product is designed to degrade, not to break.

---

# Appendix B — Anticipated judge questions

| Question | Answer |
|---|---|
| **What is the core innovation?** | The closed loop: on-device multimodal expression → explainable risk → context-aware escalation → structured record. The integration is the innovation. |
| **Is this clinically validated?** | No. It is an engineering prototype with a feasible pilot design. We state that openly on Slide 5. |
| **How is privacy handled?** | Video is processed in the browser; only landmark-derived events leave the device. Tokens are hashed; sessions are scoped; demo data is synthetic. |
| **Why not use a cloud LLM for everything?** | Latency, cost, privacy, and hallucination risk. The deterministic engine is the default; the LLM is optional and cached. |
| **What happens when the network drops?** | The bedside classifiers keep working; events queue in IndexedDB and flush on reconnect. The portal shows an honest connection state. |
| **How do you avoid alarm fatigue?** | Temporal voting, hold times, calibration, risk bands, attribution, and a stale-signal policy that distinguishes “no signal” from “deteriorating”. |
| **Can it scale to a hospital?** | Stateless routes, Redis state, SSE with polling fallback, and an on-prem path. The pilot is the next step, not a claim. |
| **What is the cost?** | Under ₹1,100 per bed for the wearable; MIT licence; local inference; hosting free tier for the demo. Training and support are the real costs. |
| **What is the biggest risk?** | Workflow fit: charging, camera placement, training, consent. That is why the pilot measures uptime and task completion first. |
| **What would you do with 6 more months?** | Run the pilot, calibrate thresholds with clinicians, add a validated usability study, and pursue the appropriate regulatory pathway. |

---

# Appendix C — Slide build checklist

- [ ] Slide 1: four-gap quadrant; three statistics; three target-user groups.
- [ ] Slide 2: closed-loop diagram; example trace; three surfaces.
- [ ] Slide 3: 12 feature cards; 5-phase methodology; 8-step prototype; 7 figures.
- [ ] Slide 4: impact table; logic model; use-case matrix; Anita/Lakshmi story in notes.
- [ ] Slide 5: evidence dashboard; pilot table; cost table; 5-step deployment; claims discipline.
- [ ] Slide 6: tech stack table; 10 innovations; differentiation matrix; layered diagram.
- [ ] Slide 7: 20 references; evidence hierarchy; citation map; limitations.
- [ ] Every slide: one kicker, one visual, one takeaway, citations in the footer.
- [ ] Every number: either counted from the repo, measured, or cited. No orphan statistics.
- [ ] Every claim: labelled verified / measured / implemented / not yet validated.

---

# Appendix D — Fast facts (for rehearsal)

| Fact | Value |
|---|---|
| Repository | Next.js 15 / React 19 / TypeScript / Tailwind 4 |
| Source + test files | 152 |
| Lines of code (src + tests) | 30,977 |
| TSX / TS source files | 53 / 88 |
| API route handlers | 33 (25 care + 8 platform) |
| Tests | 132 passing in 11 files |
| Synthetic patients | 6 |
| Synthetic records | 15 |
| Seeded sessions / tasks / messages | 2 / 2 / 2 |
| Hand landmarks | 21 |
| Face landmarks | 478 |
| Hand vote / hold | 8 frames at 75% / 500 ms |
| Eye vote / hold | 9 frames at 75% / 430 ms |
| Blink threshold | EAR 0.22 |
| Double-blink window | 700 ms |
| Risk bands | low <20 · moderate 20–44 · high 45–69 · critical ≥70 |
| Forecast | damped Holt, 15 min, α 0.4, β 0.2, φ 0.85 |
| ASR latency | 448–621 ms (median ≈475 ms) |
| TTS real-time factor | 0.168–0.392 |
| LLM first token | 63–245 ms warm |
| First spoken audio | 1.5 s best; 2.5–6 s typical on contended CPU |
| Wearable BOM target | under ₹1,100 per bed |
| Languages (AAC) | 10 Indian languages |
| Browser care call language | English only |

---

# Appendix E — Repo evidence index

| Claim | File(s) |
|---|---|
| On-device hand tracking | `src/lib/handClassifier.ts`, `src/hooks/useHandGesture.ts` |
| On-device eye tracking | `src/lib/eyeClassifier.ts`, `src/hooks/useEyeGesture.ts` |
| Risk + Shapley | `src/lib/risk.ts`, `tests/explainability.test.ts` |
| Forecast | `src/lib/forecast.ts`, `tests/forecast.test.ts` |
| Escalation | `src/lib/escalation.ts`, `src/types/index.ts` |
| Clinical corpus | `src/lib/clinicalBasis.ts`, `docs/REFERENCES.md` |
| Portal brain | `src/lib/care/portalBrain.ts`, `tests/portal-brain.test.ts` |
| Browser call | `README_CARE_WEB_CALL.md`, `src/app/care/*`, `src/app/api/care/*` |
| Store drivers | `src/lib/care/store.ts`, `tests/store.test.ts` |
| Security | `src/lib/care/auth.ts`, `src/lib/care/crypto.ts`, `SECURITY.md` |
| Performance | `PERFORMANCE_REPORT.md` |
| Hardware | `HARDWARE_REPORT.md`, `firmware/carespeak_esp32.ino` |
| Deployment | `docs/CARE_WEB_CALL_DEPLOYMENT.md`, `vercel.json` |

---

**End of deck matter.** Update this document whenever a measured number, test count, or deployment detail changes. A slide claim that cannot be traced to a file, a measurement, or a reference should be removed.



