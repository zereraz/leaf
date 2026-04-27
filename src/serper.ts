/**
 * Serper API integration for web search.
 * Supports multiple search types: search, news, scholar, patents, images, videos, places, shopping, autocomplete.
 */

const BASE_URL = "https://google.serper.dev";

export type SearchType = "search" | "news" | "images" | "scholar" | "places" | "shopping" | "patents" | "videos" | "autocomplete";

export interface SerperRequestBody {
  q: string;
  num?: number;
  gl?: string;
  hl?: string;
  page?: number;
  tbs?: string;
  location?: string;
  autocorrect?: boolean;
}

export interface OrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
  date?: string;
}

export interface NewsResult {
  title: string;
  link: string;
  snippet: string;
  date: string;
  source: string;
  imageUrl?: string;
}

export interface ScholarResult {
  title: string;
  link: string;
  snippet?: string;
  publicationInfo?: string;
  citedBy?: number;
  year?: number;
  pdfUrl?: string;
}

export interface PatentResult {
  title: string;
  snippet: string;
  link: string;
  priorityDate?: string;
  filingDate?: string;
  grantDate?: string;
  publicationDate?: string;
  inventor?: string;
  assignee?: string;
  publicationNumber?: string;
  pdfUrl?: string;
}

export interface SerperResponse {
  searchParameters: SerperRequestBody & { type: string; engine: string };
  organic?: OrganicResult[];
  news?: NewsResult[];
  suggestions?: { value: string }[];
  knowledgeGraph?: {
    title?: string;
    type?: string;
    description?: string;
    descriptionSource?: string;
    descriptionLink?: string;
    attributes?: Record<string, string>;
  };
  answerBox?: {
    title?: string;
    answer?: string;
    snippet?: string;
    link?: string;
  };
  credits: number;
}

export interface SerperSearchOptions {
  type?: SearchType;
  num?: number;
  gl?: string;
  hl?: string;
  page?: number;
  tbs?: string;
  location?: string;
  autocorrect?: boolean;
}

const SERPER_TIMEOUT_MS = 30_000;
const MAX_QUERY_LENGTH = 1000;
const MAX_NUM_RESULTS = 20;

export async function serperSearch(
  apiKey: string,
  query: string,
  options: SerperSearchOptions = {},
): Promise<SerperResponse> {
  if (!query || typeof query !== "string") throw new Error("Invalid query");
  if (query.length > MAX_QUERY_LENGTH) throw new Error("Query too long");
  const sanitizedQuery = query.trim().replace(/[<>]/g, "");
  if (options.num !== undefined && (options.num < 1 || options.num > MAX_NUM_RESULTS)) {
    throw new Error(`num must be between 1 and ${MAX_NUM_RESULTS}`);
  }

  const { type = "search", num, gl, hl, page, tbs, location, autocorrect } = options;
  const endpoint = `/${type}`;

  const body: SerperRequestBody = { q: sanitizedQuery };
  if (num !== undefined) body.num = num;
  if (gl) body.gl = gl;
  if (hl) body.hl = hl;
  if (page !== undefined) body.page = page;
  if (tbs) body.tbs = tbs;
  if (location) body.location = location;
  if (autocorrect !== undefined) body.autocorrect = autocorrect;

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Serper API error ${response.status}:`, text.substring(0, 200));
    const safeMsg = response.status === 401 ? "Search API authentication failed"
      : response.status === 429 ? "Search rate limit exceeded"
      : `Search API error (${response.status})`;
    throw new Error(safeMsg);
  }

  return response.json() as Promise<SerperResponse>;
}

export function formatSearchResults(response: SerperResponse): string {
  const parts: string[] = [];

  if (response.answerBox) {
    const ab = response.answerBox;
    parts.push("## Answer Box");
    if (ab.title) parts.push(`**${ab.title}**`);
    if (ab.answer) parts.push(ab.answer);
    if (ab.snippet) parts.push(ab.snippet);
    if (ab.link) parts.push(`Source: ${ab.link}`);
    parts.push("");
  }

  if (response.knowledgeGraph) {
    const kg = response.knowledgeGraph;
    parts.push("## Knowledge Graph");
    if (kg.title) parts.push(`**${kg.title}**${kg.type ? ` (${kg.type})` : ""}`);
    if (kg.description) parts.push(kg.description);
    if (kg.attributes) {
      for (const [key, value] of Object.entries(kg.attributes)) {
        parts.push(`- ${key}: ${value}`);
      }
    }
    parts.push("");
  }

  if (response.organic && response.organic.length > 0) {
    const isPatent = response.searchParameters.type === "patents";
    const isScholar = response.searchParameters.type === "scholar";
    const label = isPatent ? "Patent Results" : isScholar ? "Scholar Results" : "Search Results";
    parts.push(`## ${label}`);
    for (const result of response.organic) {
      parts.push(`### ${result.position ?? ""}. ${result.title}`);
      if (result.snippet) parts.push(result.snippet);
      // Scholar-specific fields
      const sr = result as unknown as ScholarResult;
      if (sr.publicationInfo) parts.push(`Publication: ${sr.publicationInfo}`);
      if (sr.year) parts.push(`Year: ${sr.year}`);
      if (sr.citedBy !== undefined) parts.push(`Cited by: ${sr.citedBy}`);
      if (sr.pdfUrl) parts.push(`PDF: ${sr.pdfUrl}`);
      // Patent-specific fields
      const pr = result as unknown as PatentResult;
      if (pr.inventor) parts.push(`Inventor: ${pr.inventor}`);
      if (pr.assignee) parts.push(`Assignee: ${pr.assignee}`);
      if (pr.filingDate) parts.push(`Filed: ${pr.filingDate}`);
      if (pr.grantDate) parts.push(`Granted: ${pr.grantDate}`);
      if (pr.publicationNumber) parts.push(`Publication: ${pr.publicationNumber}`);
      if (pr.pdfUrl && !sr.pdfUrl) parts.push(`PDF: ${pr.pdfUrl}`);
      if (result.date) parts.push(`Date: ${result.date}`);
      parts.push(`URL: ${result.link}`);
      parts.push("");
    }
  }

  if (response.news && response.news.length > 0) {
    parts.push("## News Results");
    for (const result of response.news) {
      parts.push(`### ${result.title}`);
      if (result.snippet) parts.push(result.snippet);
      parts.push(`Source: ${result.source} | ${result.date}`);
      parts.push(`URL: ${result.link}`);
      parts.push("");
    }
  }

  if (response.suggestions && response.suggestions.length > 0) {
    parts.push("## Autocomplete Suggestions");
    for (const s of response.suggestions) {
      parts.push(`- ${s.value}`);
    }
    parts.push("");
  }

  if (parts.length === 0) {
    return "No results found.";
  }

  return parts.join("\n");
}

// Truncation following pi-mono patterns
const MAX_LINES = 200;
const MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationInfo {
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export function truncateSearchResults(
  content: string,
): { content: string; truncation: TruncationInfo } {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  let outputLines = 0;
  let outputBytes = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (outputLines >= MAX_LINES || outputBytes + lineBytes > MAX_BYTES) {
      break;
    }
    kept.push(line);
    outputLines++;
    outputBytes += lineBytes;
  }

  const truncated = outputLines < totalLines;
  let result = kept.join("\n");

  if (truncated) {
    const byteNote = outputBytes >= MAX_BYTES ? ` (${Math.round(MAX_BYTES / 1024)}KB limit)` : "";
    result += `\n\n[Showing ${outputLines} of ${totalLines} lines${byteNote}. Results were truncated. Refine your query for more specific results.]`;
  }

  return {
    content: result,
    truncation: { truncated, totalLines, totalBytes, outputLines, outputBytes },
  };
}
