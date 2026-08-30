// Full play-by-play for one AI competitor's wake-up turn -- the "peek into
// AI logic" view (finance-backend/docs/league-api.md). Transcript entries are raw provider
// items verbatim (`item.model_dump(exclude_none=True)` server-side) with no
// shared shape between providers or, for OpenAI/Gemini, even within a single
// turn -- see the TranscriptEntry comment in lib/league.ts for the full
// per-provider breakdown. Anything unrecognized falls back to a collapsed
// raw JSON dump rather than silently rendering nothing.

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { getTurn, type ModelProvider, type TranscriptBlock, type TranscriptEntry, type TurnDetail } from "../lib/league";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime } from "../lib/format";

export function TurnTranscriptModal({
  competitorId,
  turnId,
  provider,
  onClose,
}: {
  competitorId: number;
  turnId: number;
  provider: ModelProvider;
  onClose: () => void;
}) {
  const [turn, setTurn] = useState<TurnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTurn(competitorId, turnId)
      .then((t) => {
        if (!cancelled) setTurn(t);
      })
      .catch((err) => {
        if (!cancelled) setError(extractGenericMessage(err, "Couldn't load this turn."));
      });
    return () => {
      cancelled = true;
    };
  }, [competitorId, turnId]);

  return (
    <Modal title="Turn transcript" onClose={onClose} wide className="league-transcript-dialog">
      {error && <p className="form-error">{error}</p>}
      {!error && !turn && <p className="text-muted">Loading…</p>}
      {turn && (
        <div className="stack">
          <div className="card-meta">
            {formatDateTime(turn.created_at)} · {turn.trigger === "manual" ? "Manual trigger" : "Self-scheduled"} ·{" "}
            {turn.input_tokens.toLocaleString()} in / {turn.output_tokens.toLocaleString()} out · ${turn.cost_usd}
          </div>
          {turn.transcript.map((entry, i) => (
            <div className="league-transcript-entry" key={i}>
              <div className="card-kicker">{entryKicker(entry)}</div>
              {entry.role === "user" ? (
                entry.text && <p className="league-transcript-text">{entry.text}</p>
              ) : provider === "openai" ? (
                <OpenAiEntryView entry={entry} />
              ) : provider === "gemini" ? (
                <GeminiEntryView entry={entry} />
              ) : provider === "anthropic" ? (
                <AnthropicEntryView entry={entry} />
              ) : (
                <RawEntryView entry={entry} />
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function entryKicker(entry: TranscriptEntry): string {
  if (entry.role === "user") return "Wake-up prompt";
  if (entry.role === "tool" || entry.type === "function_call_output") return "Tool result";
  return "Assistant";
}

function RawEntryView({ entry }: { entry: TranscriptEntry }) {
  return (
    <details className="league-transcript-tool">
      <summary>Raw entry{typeof entry.type === "string" ? ` (${entry.type})` : ""}</summary>
      <pre>{JSON.stringify(entry, null, 2)}</pre>
    </details>
  );
}

// --- Anthropic: one entry per turn, `content` is an array of blocks. ---

function AnthropicEntryView({ entry }: { entry: TranscriptEntry }) {
  const blocks = Array.isArray(entry.content) ? (entry.content as TranscriptBlock[]) : [];
  if (!entry.text && blocks.length === 0) return <RawEntryView entry={entry} />;
  return (
    <>
      {entry.text && <p className="league-transcript-text">{entry.text}</p>}
      {blocks.map((block, j) => (
        <AnthropicBlockView block={block} key={j} />
      ))}
    </>
  );
}

function AnthropicBlockView({ block }: { block: TranscriptBlock }) {
  if (block.type === "text" && typeof block.text === "string") {
    return <p className="league-transcript-text">{block.text}</p>;
  }
  if ((block.type === "tool_use" || block.type === "server_tool_use") && typeof block.name === "string") {
    return (
      <pre className="league-transcript-tool">
        Called {block.name}({JSON.stringify(block.input ?? {}, null, 2)})
      </pre>
    );
  }
  if (block.type === "web_search_tool_result") {
    const content = Array.isArray(block.content) ? (block.content as Record<string, unknown>[]) : [];
    return (
      <div className="league-transcript-tool">
        Web search results ({content.length}):
        <ul>
          {content.map((r, i) => (
            <li key={i}>
              {typeof r.url === "string" ? (
                <a href={r.url} target="_blank" rel="noopener noreferrer">
                  {typeof r.title === "string" ? r.title : r.url}
                </a>
              ) : (
                JSON.stringify(r)
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <details className="league-transcript-tool">
      <summary>Raw block{typeof block.type === "string" ? ` (${block.type})` : ""}</summary>
      <pre>{JSON.stringify(block, null, 2)}</pre>
    </details>
  );
}

// --- OpenAI: one entry PER RESPONSE ITEM, fields flattened onto the entry
// (see the TranscriptEntry comment in lib/league.ts). Dispatch on `type`. ---

function OpenAiEntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.type) {
    case "message": {
      const parts = Array.isArray(entry.content) ? (entry.content as TranscriptBlock[]) : [];
      const text = parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      return text ? <p className="league-transcript-text">{text}</p> : <RawEntryView entry={entry} />;
    }
    case "function_call": {
      if (typeof entry.name !== "string") return <RawEntryView entry={entry} />;
      let args: unknown = entry.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          // leave as the raw (non-JSON) string
        }
      }
      return (
        <pre className="league-transcript-tool">
          Called {entry.name}({JSON.stringify(args, null, 2)})
        </pre>
      );
    }
    case "function_call_output": {
      const output = entry.output;
      return <pre className="league-transcript-tool">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>;
    }
    case "web_search_call":
      return <div className="league-transcript-tool">Web search{typeof entry.status === "string" ? ` (${entry.status})` : ""}</div>;
    case "reasoning":
      return <OpenAiReasoningView entry={entry} />;
    default:
      return <RawEntryView entry={entry} />;
  }
}

// Reasoning items are routine (roughly one per turn round) with the model
// currently in use -- effort="low" requests no summary, so `summary` is `[]`
// and the only payload is an opaque `encrypted_content` blob. Give it its
// own collapsed chip instead of raw-dumping every time.
function OpenAiReasoningView({ entry }: { entry: TranscriptEntry }) {
  const summary = Array.isArray(entry.summary) ? (entry.summary as Record<string, unknown>[]) : [];
  const summaryText = summary
    .map((s) => (typeof s.text === "string" ? s.text : ""))
    .filter(Boolean)
    .join("\n");
  return (
    <details className="league-transcript-tool">
      <summary>🤔 Reasoning step</summary>
      {summaryText ? (
        <p className="league-transcript-text">{summaryText}</p>
      ) : (
        <p className="text-muted">No summary was requested for this turn -- the model's reasoning content isn't exposed.</p>
      )}
    </details>
  );
}

// --- Gemini: one entry per `Part`, also flattened, and Part has no `type`
// discriminator -- sniff by which key is present (see the TranscriptEntry
// comment in lib/league.ts for the field shapes). ---

function GeminiEntryView({ entry }: { entry: TranscriptEntry }) {
  if (entry.type === "grounding_metadata") return <GeminiGroundingView entry={entry} />;

  if (entry.function_call && typeof entry.function_call === "object") {
    const fc = entry.function_call as Record<string, unknown>;
    if (typeof fc.name !== "string") return <RawEntryView entry={entry} />;
    return (
      <pre className="league-transcript-tool">
        Called {fc.name}({JSON.stringify(fc.args ?? {}, null, 2)})
      </pre>
    );
  }

  if (entry.function_response && typeof entry.function_response === "object") {
    const fr = entry.function_response as Record<string, unknown>;
    return <pre className="league-transcript-tool">{JSON.stringify(fr.response ?? fr, null, 2)}</pre>;
  }

  // Server-side built-in tool call/response pair (e.g. the execution step
  // behind Google Search grounding) -- textless by design, just a signature
  // and an opaque call/response object.
  if (entry.tool_call || entry.tool_response) {
    const isCall = Boolean(entry.tool_call);
    return (
      <details className="league-transcript-tool">
        <summary>⚙️ Built-in tool {isCall ? "call" : "response"}</summary>
        <pre>{JSON.stringify(entry.tool_call ?? entry.tool_response, null, 2)}</pre>
      </details>
    );
  }

  if (typeof entry.text === "string" && entry.text) {
    if (entry.thought === true) {
      return (
        <details className="league-transcript-tool">
          <summary>🤔 Reasoning</summary>
          <p className="league-transcript-text">{entry.text}</p>
        </details>
      );
    }
    return <p className="league-transcript-text">{entry.text}</p>;
  }

  return <RawEntryView entry={entry} />;
}

function GeminiGroundingView({ entry }: { entry: TranscriptEntry }) {
  const chunks = Array.isArray(entry.grounding_chunks) ? (entry.grounding_chunks as Record<string, unknown>[]) : [];
  const queries = Array.isArray(entry.web_search_queries) ? (entry.web_search_queries as unknown[]) : [];
  return (
    <div className="league-transcript-tool">
      Web search grounding{queries.length ? `: ${queries.map(String).join(", ")}` : ""}
      <ul>
        {chunks.map((c, i) => {
          const web = (c.web as Record<string, unknown>) ?? {};
          return (
            <li key={i}>
              {typeof web.uri === "string" ? (
                <a href={web.uri} target="_blank" rel="noopener noreferrer">
                  {typeof web.title === "string" ? web.title : web.uri}
                </a>
              ) : (
                JSON.stringify(c)
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
