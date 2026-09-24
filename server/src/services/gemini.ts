import { getAiProvider } from "../ai/index";

export interface SmgData {
  conceptNode?: string;
  errorTypeMap?: Record<string, number>;
  recentInteractions?: Array<{ q: string; a: string }>;
  /** Student-wide weak concepts (from getStudentProfile). */
  weakConcepts?: string[];
}

interface SmgSectionOptions {
  label?: string;
  includeInteractions?: boolean;
  includeDifficulty?: number | null;
}

function buildSmgSection(
  smg: SmgData | null | undefined,
  { label, includeInteractions = false, includeDifficulty = null }: SmgSectionOptions = {},
) {
  if (!smg) return "";
  const topErrors = Object.entries(smg.errorTypeMap || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  const weak = (smg.weakConcepts || []).slice(0, 5);
  if (!topErrors.length && !weak.length && !includeDifficulty && !(includeInteractions && smg.recentInteractions?.length)) {
    return "";
  }

  let section = `--- STUDENT HISTORY (${label || "Overall"}) ---\n`;
  if (topErrors.length) section += `Primary Misconceptions: ${topErrors.join(", ")}\n`;
  if (weak.length) section += `Currently Weak Concepts: ${weak.map((c) => c.replace(/_/g, " ")).join(", ")}\n`;
  if (includeDifficulty) section += `Recent Difficulty: ${includeDifficulty}/10\n`;
  if (includeInteractions && smg.recentInteractions) {
    section += `Recent Interactions:\n${smg.recentInteractions.slice(-3).map(i => `- Q: ${i.q}\n  A: ${i.a}`).join("\n")}\n`;
  }
  return section + "\n";
}

/**
 * Identify the core concept being asked in a question.
 */
export async function identifyConcept(question: string): Promise<any> {
  const prompt = `Identify the single most specific academic concept or topic in the following student question.
Question: ${question}

Respond with ONLY a JSON object:
{
  "concept": "string",
  "confidence": <number between 0 and 1>
}`;

  return getAiProvider().generateJson({
    model: "fast",
    prompt,
    temperature: 0.0,
  });
}

/**
 * Explain a concept using provided context and student history.
 */
export async function explainConcept(
  question: string,
  context: string,
  smg: SmgData | null = null,
): Promise<any> {
  const smgSection = buildSmgSection(smg, { label: "this student", includeInteractions: true });
  const compactContext = context ? context.slice(0, 5000) : "";

  const prompt = `You are an AI study companion. A student asked the following question.
Use the course material context below to help when it is relevant.

Rules:
- If the question is not actually an academic/study question (e.g. greetings like "hi"), answer it briefly and normally. Do NOT force-fit unrelated course material.
- If the question is academic, prioritize answering the question directly.
- Only lean heavily on course material context when it clearly matches the question. If context is unrelated, ignore it.
- If STUDENT HISTORY is present and relevant, use "personalizedCallout" to address the specific misconception pattern in one or two sentences. Otherwise leave it empty.

COURSE MATERIAL CONTEXT:
${compactContext || "No course materials available — use your general knowledge."}
${smgSection}

STUDENT QUESTION:
${question}

Respond with ONLY a JSON object:
{
  "solution": "string (markdown allowed, use $...$ for inline math, $$...$$ for block math)",
  "mainConcept": "string (short)",
  "relevantLecture": "string (or empty string)",
  "keyFormulas": ["string", "string"],
  "personalizedCallout": "string (or empty string)"
}`;

  return getAiProvider().generateJson({
    model: "primary",
    prompt,
    temperature: 0.4,
  });
}

/**
 * Classify an interaction for SMG tagging.
 * Returns { conceptNode, errorType, confidence }.
 *
 * @param knownConcepts the student's existing concept ids; the model is asked to reuse one
 *   when it fits so the SMG does not fragment into near-duplicate nodes.
 */
export async function classifyConcept(question: string, solution: string, knownConcepts: string[] = []): Promise<any> {
  const compactQ = String(question || "").slice(0, 1200);
  const compactSol = String(solution || "").slice(0, 2000);
  const known = knownConcepts.slice(0, 40);
  const knownSection = known.length
    ? `\nThe student already has these concept ids. If one of them is the concept here, return it EXACTLY; only invent a new id when none fits:\n${known.join(", ")}\n`
    : "";

  const prompt = `You are classifying a student's question and the AI's solution into a concept node and error type.

Question:
${compactQ}

Solution:
${compactSol}
${knownSection}
Guidance:
- conceptNode is the most specific course concept involved, in snake_case (e.g. integration_by_parts, not calculus).
- errorType is the misconception the student's question reveals. Use "none" when the question shows no misunderstanding (e.g. a plain request for an explanation).

Return ONLY this JSON:
{
  "conceptNode": "string (snake_case)",
  "errorType": "conceptual_misunderstanding | procedural_error | knowledge_gap | reasoning_error | none",
  "confidence": number (0 to 1)
}`;

  return getAiProvider().generateJson({
    model: "fast",
    prompt,
    temperature: 0.0,
  });
}

/**
 * Generate a quiz from topic + RAG chunks (and optional weakest-concept hints).
 */
export async function generateQuiz(
  topic: string,
  chunks: string[] = [],
  smgData: SmgData | null = null,
  count = 3,
): Promise<any> {
  const contextText = chunks.join("\n\n---\n\n");
  const compactContext = contextText.slice(0, 8000);
  const smgHint = smgData
    ? `Student weak concept hint: ${smgData.conceptNode || ""}. Common error types: ${Object.keys(smgData.errorTypeMap || {}).join(", ")}`
    : "";

  const prompt = `Generate ${count} multiple-choice questions for the topic "${topic || "general"}".
Use the course material context when relevant.
${smgHint}

CONTEXT:
${compactContext || "No course material provided."}

Respond with ONLY a JSON object:
{
  "questions": [
    {
      "question": "string",
      "options": ["string", "string", "string", "string"],
      "answer": number,
      "explanation": "string",
      "difficulty": "easy | medium | hard",
      "conceptNode": "string"
    }
  ]
}`;

  return getAiProvider().generateJson({
    model: "primary",
    prompt,
    temperature: 0.7,
  });
}

/**
 * Explain a question with streaming.
 */
export async function explainConceptStream(question: string, context: string = "", smg: SmgData | null = null): Promise<any> {
  const compactContext = context.slice(0, 5000);
  const compactQuestion = question.slice(0, 500);
  const smgSection = buildSmgSection(smg, { label: "this student" });

  const prompt = `You are an AI study companion. Explain this concept clearly using the context provided.
If STUDENT HISTORY is present and relevant, briefly address that misconception pattern.
CONTEXT: ${compactContext}
${smgSection}STUDENT QUESTION: ${compactQuestion}

Give a clear, step-by-step explanation. Highlight key formulas. Be concise but thorough.`;

  return getAiProvider().streamText({
    model: "primary",
    prompt,
    temperature: 0.4,
  });
}

/** Back-compat: older routes import this name when bundling resolves .js. */
export const explainStreaming = explainConceptStream;

/**
 * Discover the top 5 core academic concepts in a text for initial graph population.
 */
export async function discoverConcepts(text: string): Promise<{ concepts: string[] }> {
  const prompt = `Analyze the following academic material and identify the top 5 most important core concepts, topics, or formulas.
Respond with ONLY a JSON object:
{
  "concepts": ["concept_one", "concept_two", "concept_three", "concept_four", "concept_five"]
}

Rules:
- Concepts must be lowercase_snake_case.
- Concepts should be specific academic terms (e.g., "tangent_planes", "partial_derivatives", not "math").
- If the text is very short, you can return fewer than 5 concepts.

TEXT:
${text.slice(0, 10000)}`;

  try {
    const res = await getAiProvider().generateJson({
      model: "fast",
      prompt,
      temperature: 0.0,
    });
    return { concepts: res.concepts || [] };
  } catch {
    return { concepts: [] };
  }
}
