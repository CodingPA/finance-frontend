// Full play-by-play for one AI competitor's wake-up turn -- the "peek into
// AI logic" view (docs/league-api.md). Transcript blocks are raw Anthropic
// content blocks (`block.model_dump()` server-side), so this renders known
// block types (text/tool_use/server_tool_use/web_search_tool_result) and
// falls back to a raw dump for anything else rather than silently dropping it.

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { getTurn, type TranscriptBlock, type TurnDetail } from "../lib/league";
import { extractGenericMessage } from "../lib/formErrors";
import { formatDateTime } from "../lib/format";

export function TurnTranscriptModal({
  competitorId,
  turnId,
  onClose,
}: {
  competitorId: number;
  turnId: number;
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
    <Modal title="Turn transcript" onClose={onClose} wide>
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
              <div className="card-kicker">{entry.role === "user" ? "Wake-up prompt" : "Claude"}</div>
              {entry.text && <p className="league-transcript-text">{entry.text}</p>}
              {entry.content?.map((block, j) => (
                <TranscriptBlockView block={block} key={j} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function TranscriptBlockView({ block }: { block: TranscriptBlock }) {
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
  return <pre className="league-transcript-tool">{JSON.stringify(block, null, 2)}</pre>;
}
