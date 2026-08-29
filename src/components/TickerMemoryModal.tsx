import { Modal } from "./Modal";
import { Markdown } from "./Markdown";
import { formatDateTime } from "../lib/format";
import type { TickerMemory } from "../lib/league";

export function TickerMemoryModal({ memory, onClose }: { memory: TickerMemory; onClose: () => void }) {
  return (
    <Modal title={`Ticker research — ${memory.ticker}`} onClose={onClose} wide>
      <div className="stack">
        <div className="card-meta">Updated {formatDateTime(memory.updated_at)}</div>
        <div className="card-body markdown-body">
          <Markdown>{memory.content}</Markdown>
        </div>
      </div>
    </Modal>
  );
}
