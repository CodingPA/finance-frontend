// Add a competitor to a league competition. Model choices come from
// GET /league/models/ -- every active model across both providers, distinct
// from the Anthropic-only main-chat picker -- so this is the one place in
// the app a GPT-backed competitor can be created. A persona/strategy system
// prompt is still required so every AI competitor is actually differentiated.

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { useAuth } from "../context/AuthContext";
import { addCompetitor, listModels, type CompetitorKind, type CompetitorSummary, type LeagueModel } from "../lib/league";
import { extractFieldErrors, extractGenericMessage, type FieldErrors } from "../lib/formErrors";

export function AddCompetitorModal({
  competitionId,
  hasHumanCompetitor,
  onClose,
  onJoined,
}: {
  competitionId: number;
  hasHumanCompetitor: boolean;
  onClose: () => void;
  onJoined: (competitor: CompetitorSummary) => void;
}) {
  const { user } = useAuth();
  const [kind, setKind] = useState<CompetitorKind>("human");
  const [name, setName] = useState(hasHumanCompetitor ? "" : user?.name || "Me");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [models, setModels] = useState<LeagueModel[] | null>(null);
  const [modelId, setModelId] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setModelId((current) => current || list.find((m) => m.is_default)?.model_id || list[0]?.model_id || "");
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const competitor = await addCompetitor(competitionId, {
        name: name.trim() || "Me",
        kind,
        ...(kind === "ai" ? { system_prompt: systemPrompt, ...(modelId ? { model: modelId } : {}) } : {}),
      });
      onJoined(competitor);
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setError(extractGenericMessage(err, "Couldn't add that competitor."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Add competitor" onClose={onClose}>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="seg" role="radiogroup" aria-label="Competitor kind">
          <label className="seg-opt">
            <input type="radio" name="competitor-kind" checked={kind === "human"} onChange={() => setKind("human")} />
            Human
          </label>
          <label className="seg-opt">
            <input type="radio" name="competitor-kind" checked={kind === "ai"} onChange={() => setKind("ai")} />
            AI
          </label>
        </div>

        <div className="field">
          <label htmlFor="competitor-name">Name</label>
          <input
            id="competitor-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {fieldErrors.name?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
        </div>

        {kind === "ai" && (
          <>
            <div className="field">
              <label htmlFor="competitor-model">Model</label>
              <select
                id="competitor-model"
                className="input"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                disabled={!models || models.length === 0}
              >
                {!models && <option value="">Loading…</option>}
                {models?.length === 0 && <option value="">No models available</option>}
                {models?.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.display_name} ({m.provider === "anthropic" ? "Anthropic" : "OpenAI"})
                    {m.is_default ? " -- default" : ""}
                  </option>
                ))}
              </select>
              {fieldErrors.model?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>

            <div className="field">
              <label htmlFor="competitor-prompt">System prompt / persona</label>
              <textarea
                id="competitor-prompt"
                className="input"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="e.g. A contrarian value investor who only buys after a 20%+ drawdown..."
                required
              />
              {fieldErrors.system_prompt?.map((msg) => (
                <p className="form-error" key={msg}>
                  {msg}
                </p>
              ))}
            </div>
          </>
        )}

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Adding…" : "Add competitor"}
        </button>
      </form>
    </Modal>
  );
}
