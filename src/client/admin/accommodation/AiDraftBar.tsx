import { useState } from "react";
import type { UnitTranslationDto } from "../../../shared/accommodation-types.ts";
import type { AiDraftMode, UnitTextDraftDto } from "../../../shared/ai-content-types.ts";
import { aiMarketingMessages } from "../../../shared/i18n/ai-marketing-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { LocaleCode } from "../../../shared/i18n/locales.ts";
import { ApiError, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Button, errorMessage } from "../ui.tsx";

/**
 * AI content helper (Module B) above the texts of one language: the AI writes (or translates from Thai) the name,
 * descriptions and search texts into the form. Nothing is saved: staff read it, change what they like and press
 * Save — or put the previous texts back.
 */
export function AiDraftBar({ unitId, lang, texts, onDraft }: {
  unitId: string;
  lang: LocaleCode;
  texts: Record<LocaleCode, UnitTranslationDto>;
  onDraft: (next: UnitTranslationDto) => void;
}) {
  const { t, locale } = useAdmin();
  const m = aiMarketingMessages(locale.code).draft;
  const [mode, setMode] = useState<AiDraftMode>(lang === "th" ? "WRITE" : "TRANSLATE");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [before, setBefore] = useState<UnitTranslationDto | null>(null);
  const effective: AiDraftMode = lang === "th" ? "WRITE" : mode;

  async function draft() {
    setBusy(true);
    setNote(null);
    try {
      const d = await apiRequest<UnitTextDraftDto>("POST", `/api/admin/accommodations/${encodeURIComponent(unitId)}/ai-draft`, { lang, mode: effective, texts });
      setBefore(texts[lang]);
      onDraft({ name: d.name, shortDescription: d.shortDescription || null, description: d.description, seoTitle: d.seoTitle || null, seoDescription: d.seoDescription || null });
      setNote({ kind: "ok", text: format(m.done, { model: d.model }) });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      const text = code === "AI_OFF" ? m.off : code === "AI_BUDGET_REACHED" ? m.budget : code === "TOO_MANY_REQUESTS" ? m.tooMany
        : err instanceof ApiError && err.details.mode === "THAI_TEXT_REQUIRED" ? m.needThai : code === "AI_FAILED" ? m.failed : errorMessage(t, err);
      setNote({ kind: "error", text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="aim-draft" data-testid="ai-draft">
      <div className="aim-draft__row">
        {lang !== "th" && (
          <label className="aim-draft__mode">
            <span className="visually-hidden">{m.modeLabel}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as AiDraftMode)}>
              <option value="TRANSLATE">{m.TRANSLATE}</option>
              <option value="WRITE">{m.WRITE}</option>
            </select>
          </label>
        )}
        <Button variant="secondary" busy={busy} onClick={() => void draft()}>{busy ? m.working : m.button}</Button>
        {before && (
          <button type="button" className="adm-linkbtn" onClick={() => { onDraft(before); setBefore(null); setNote(null); }}>{m.undo}</button>
        )}
      </div>
      {note && <p className={`adm-small ${note.kind === "error" ? "adm-field__error" : "aim-draft__ok"}`} role="status">{note.text}</p>}
      {!note && <p className="adm-small adm-muted">{m.hint}</p>}
    </div>
  );
}
