// Add a competitor to a league competition. Model choices come from
// GET /league/models/ -- every active model across both providers, distinct
// from the Anthropic-only main-chat picker -- so this is the one place in
// the app a GPT-backed competitor can be created. A persona/strategy system
// prompt is still required so every AI competitor is actually differentiated.

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { CompetitorAvatar } from "./CompetitorAvatar";
import { useAuth } from "../context/AuthContext";
import { addCompetitor, listModels, type CompetitorKind, type CompetitorSummary, type LeagueModel, type ModelProvider } from "../lib/league";
import { extractFieldErrors, extractGenericMessage, type FieldErrors } from "../lib/formErrors";

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
};

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
  const [color, setColor] = useState("");
  const [avatar, setAvatar] = useState("");
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
        ...(color.trim() ? { color: color.trim() } : {}),
        ...(avatar.trim() ? { avatar: avatar.trim() } : {}),
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

        <div className="field">
          <label htmlFor="competitor-color">Color &amp; avatar (optional)</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <CompetitorAvatar color={color} avatar={avatar} size={32} />
            <input
              id="competitor-color"
              type="color"
              value={color || "#2563EB"}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 36, height: 32, padding: 0, border: "none", background: "none" }}
              aria-label="Color"
            />
            <input
              className="input"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="#2563EB"
              maxLength={7}
              style={{ maxWidth: 100 }}
              aria-label="Color hex code"
            />
            <input
              className="input"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              placeholder="🧭"
              maxLength={8}
              style={{ maxWidth: 60 }}
              aria-label="Avatar emoji"
            />
          </div>
          {fieldErrors.color?.map((msg) => (
            <p className="form-error" key={msg}>
              {msg}
            </p>
          ))}
          {fieldErrors.avatar?.map((msg) => (
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
                    {m.display_name} ({PROVIDER_LABELS[m.provider]})
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
