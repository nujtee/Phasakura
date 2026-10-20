import { useEffect, useState } from "react";
import type { ChannexAutoCreateDto, ChannexPropertiesDto, ChannexRoomsDto, ChannexStatusDto, ChannexUnitDto } from "../../../shared/channel-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Button, useDateFormatter } from "../ui.tsx";
import { useTexts, type Confirm, type Msg } from "./ChannelsPage.tsx";

/** Channex (phase O2): connect the account, choose the property, map each house / VIP tent to a room type. */
export function ChannexSection({ status, canEdit, onStatus, setMsg, fail, setConfirm }: {
  status: ChannexStatusDto; canEdit: boolean; onStatus: (s: ChannexStatusDto) => void;
  setMsg: (m: Msg) => void; fail: (err: unknown) => void; setConfirm: (c: Confirm) => void;
}) {
  const m = useTexts();
  const c = m.channex;
  const { locale } = useAdmin();
  const date = useDateFormatter();
  const [busy, setBusy] = useState(false);
  const [properties, setProperties] = useState<ChannexPropertiesDto["properties"] | null>(null);
  const [chosen, setChosen] = useState("");
  const [rooms, setRooms] = useState<ChannexRoomsDto | null>(null);

  const run = async (call: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await call();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const test = () => run(async () => {
    const res = await apiRequest<ChannexPropertiesDto>("POST", "/api/admin/channels/channex/test", {});
    setProperties(res.properties);
    setChosen(status.property?.id ?? res.properties[0]?.id ?? "");
    setMsg({ kind: "success", text: format(c.tested, { n: res.properties.length }) });
  });

  const saveProperty = () => {
    const doIt = () => run(async () => {
      onStatus(await apiRequest<ChannexStatusDto>("PUT", "/api/admin/channels/channex/property", { propertyId: chosen || null }));
      setRooms(null);
      setMsg({ kind: "success", text: c.propertySaved });
    });
    if (status.property && status.property.id !== chosen && status.units.some((u) => u.roomTypeId)) {
      setConfirm({ message: c.confirmProperty, label: c.useProperty, danger: true, run: doIt });
    } else void doIt();
  };

  const loadRooms = () => run(async () => setRooms(await apiGet<ChannexRoomsDto>("/api/admin/channels/channex/rooms")));

  const unmapped = status.units.filter((u) => !u.roomTypeId);
  const autoCreate = () => setConfirm({
    message: format(c.confirmAutoCreate, { n: unmapped.length }), label: c.autoCreate,
    run: () => run(async () => {
      const res = await apiRequest<ChannexAutoCreateDto>("POST", "/api/admin/channels/channex/auto-create", {});
      onStatus(res.status);
      setRooms(null);
      const code = (id: string) => status.units.find((u) => u.unitId === id)?.unitCode ?? id;
      setMsg(res.failed.length
        ? { kind: "error", text: `${format(c.created, { n: res.created.length })} · ${format(c.createdFailed, { n: res.failed.length, errors: res.failed.map((f) => `${code(f.unitId)}: ${f.error}`).join("; ") })}` }
        : { kind: "success", text: format(c.created, { n: res.created.length }) });
    }),
  });

  return (
    <div className="adm-card adm-channels__channex">
      <h2 className="adm-h2">{c.title}</h2>
      <p className="adm-small">{format(c.env, { env: status.environment === "production" ? c.envProduction : c.envStaging })}</p>
      <p className="adm-field__hint">{c.notYet}</p>

      <h3 className="adm-h3">{c.step1}</h3>
      <p>
        <strong>{c.property}:</strong> {status.property ? `${status.property.title ?? status.property.id}${status.property.currency ? ` · ${status.property.currency}` : ""}` : c.noProperty}
      </p>
      {status.lastCheckAt && (
        <p className={`adm-field__hint${status.lastCheckStatus === "ERROR" ? " adm-channels__error" : ""}`}>
          {format(c.lastCheck, { time: date(status.lastCheckAt), status: status.lastCheckStatus === "OK" ? "OK" : status.lastCheckError ?? "ERROR" })}
        </p>
      )}
      {canEdit && <Button variant="secondary" disabled={busy} busy={busy} onClick={() => void test()}>{c.test}</Button>}
      {properties && properties.length > 0 && (canEdit ? (
        <div className="adm-row adm-row--wrap adm-channels__pick">
          <label className="adm-field adm-field--inline"><span>{c.choose}</span>
            <select value={chosen} onChange={(e) => setChosen(e.currentTarget.value)}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.title}{p.currency ? ` (${p.currency})` : ""}</option>)}
            </select>
          </label>
          <Button disabled={busy || !chosen || chosen === status.property?.id} onClick={saveProperty}>{c.useProperty}</Button>
        </div>
      ) : <p className="adm-field__hint">{c.onlySuper}</p>)}

      {status.property && (
        <>
          <h3 className="adm-h3">{c.step2}</h3>
          <p className="adm-field__hint">{c.step2Hint}</p>
          {canEdit && (
            <div className="adm-row adm-row--wrap">
              <Button variant="secondary" disabled={busy} onClick={() => void loadRooms()}>{c.loadRooms}</Button>
              {unmapped.length > 0 && <Button disabled={busy} onClick={autoCreate}>{c.autoCreate}</Button>}
            </div>
          )}
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead><tr><th scope="col">{c.unit}</th><th scope="col">{c.roomType}</th><th scope="col">{c.ratePlan}</th><th scope="col" /></tr></thead>
              <tbody>
                {status.units.map((u) => (
                  <UnitRow key={u.unitId} unit={u} rooms={rooms} canEdit={canEdit} busy={busy} name={u.names[locale.code] ?? u.names.th ?? u.unitCode}
                    onSave={(roomTypeId, ratePlanId) => run(async () => {
                      onStatus(await apiRequest<ChannexStatusDto>("PUT", `/api/admin/channels/channex/units/${encodeURIComponent(u.unitId)}`, { roomTypeId, ratePlanId }));
                      setMsg({ kind: "success", text: c.mapSaved });
                    })} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="adm-field__hint">{c.icalWarn}</p>
          {status.ari.supported && <AriBlock status={status} canEdit={canEdit} busy={busy} run={run} onStatus={onStatus} setMsg={setMsg} setConfirm={setConfirm} />}
        </>
      )}
    </div>
  );
}

function UnitRow({ unit, rooms, canEdit, busy, name, onSave }: {
  unit: ChannexUnitDto; rooms: ChannexRoomsDto | null; canEdit: boolean; busy: boolean; name: string;
  onSave: (roomTypeId: string | null, ratePlanId: string | null) => Promise<void>;
}) {
  const c = useTexts().channex;
  const [room, setRoom] = useState(unit.roomTypeId ?? "");
  const [rate, setRate] = useState(unit.ratePlanId ?? "");
  // A save / auto-create elsewhere changes the mapping: show the saved values.
  useEffect(() => { setRoom(unit.roomTypeId ?? ""); setRate(unit.ratePlanId ?? ""); }, [unit.roomTypeId, unit.ratePlanId]);
  const plans = rooms?.ratePlans.filter((p) => p.roomTypeId === room) ?? [];
  const changed = room !== (unit.roomTypeId ?? "") || rate !== (unit.ratePlanId ?? "");
  return (
    <tr>
      <td>{name}<div className="adm-small adm-muted">{unit.unitCode} · {unit.roomTypeId ? c.mapped : c.unmapped}</div></td>
      <td>
        {rooms && canEdit ? (
          <select aria-label={`${c.roomType} ${unit.unitCode}`} value={room} onChange={(e) => { setRoom(e.currentTarget.value); setRate(""); }}>
            <option value="">{c.none}</option>
            {rooms.roomTypes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        ) : unit.roomTypeTitle ?? "—"}
      </td>
      <td>
        {rooms && canEdit ? (
          <select aria-label={`${c.ratePlan} ${unit.unitCode}`} value={rate} disabled={!room} onChange={(e) => setRate(e.currentTarget.value)}>
            <option value="">{c.noRate}</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.title}{p.currency ? ` (${p.currency})` : ""}</option>)}
          </select>
        ) : unit.ratePlanTitle ?? "—"}
      </td>
      <td>{rooms && canEdit && <Button variant="secondary" disabled={busy || !changed} onClick={() => void onSave(room || null, rate || null)}>{c.save}</Button>}</td>
    </tr>
  );
}

function AriBlock({ status, canEdit, busy, run, onStatus, setMsg, setConfirm }: {
  status: ChannexStatusDto; canEdit: boolean; busy: boolean; run: (call: () => Promise<void>) => Promise<void>;
  onStatus: (s: ChannexStatusDto) => void; setMsg: (m: Msg) => void; setConfirm: (c: Confirm) => void;
}) {
  const c = useTexts().channex;
  const date = useDateFormatter();
  const a = status.ari;
  const [markup, setMarkup] = useState(String(a.markupPercent));
  useEffect(() => setMarkup(String(a.markupPercent)), [a.markupPercent]);
  const put = (body: { enabled?: boolean; markupPercent?: number }, done: string) => run(async () => {
    onStatus(await apiRequest<ChannexStatusDto>("PUT", "/api/admin/channels/channex/ari", body));
    setMsg({ kind: "success", text: done });
  });
  const statusText = a.lastPushStatus === "OK" ? c.pushOk : a.lastPushStatus === "WARNING" ? c.pushWarning : c.pushError;
  const mappedAny = status.units.some((u) => u.roomTypeId);
  const markupValue = Number(markup);
  const markupOk = markup.trim() !== "" && Number.isInteger(markupValue) && markupValue >= 0 && markupValue <= 100;
  return (
    <div className="adm-channels__ari">
      <h3 className="adm-h3">{c.step3}</h3>
      <p className="adm-field__hint">{c.step3Hint}</p>
      <p className="adm-small">{status.environment === "production" ? c.liveBlocked : c.stagingNote}</p>
      <p>
        <span className={`adm-badge ${a.enabled ? "adm-badge--active" : "adm-badge--suspended"}`}>{a.enabled ? c.sending : c.notSending}</span>
        {a.lastPushAt && (
          <span className={`adm-small${a.lastPushStatus === "OK" ? "" : " adm-channels__error"}`}>
            {" "}{format(c.lastPush, { time: date(a.lastPushAt), status: statusText, n: a.lastPushChanges ?? 0 })}
            {a.lastFullPushAt && <> · {format(c.lastFull, { time: date(a.lastFullPushAt) })}</>}
          </span>
        )}
      </p>
      {a.lastPushStatus && a.lastPushStatus !== "OK" && a.lastPushError && <p className="adm-small adm-channels__error">{a.lastPushError}</p>}
      {canEdit && (
        <>
          <form className="adm-row adm-row--wrap" onSubmit={(e) => { e.preventDefault(); if (markupOk) void put({ markupPercent: markupValue }, c.markupSaved); }}>
            <label className="adm-field adm-field--inline"><span>{c.markup}</span>
              <input type="number" inputMode="numeric" min={0} max={100} step={1} value={markup} onChange={(e) => setMarkup(e.currentTarget.value)} style={{ width: "6em" }} /></label>
            <Button type="submit" variant="secondary" disabled={busy || !markupOk || markupValue === a.markupPercent}>{c.saveMarkup}</Button>
          </form>
          <p className="adm-field__hint">{c.markupHint}</p>
          <div className="adm-row adm-row--wrap">
            {a.enabled ? (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
                  onStatus(await apiRequest<ChannexStatusDto>("POST", "/api/admin/channels/channex/push", {}));
                  setMsg({ kind: "success", text: c.pushed });
                })}>{c.pushNow}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm({ message: c.confirmStop, label: c.stop, danger: true, run: () => put({ enabled: false }, c.notSending) })}>{c.stop}</Button>
              </>
            ) : (
              <Button disabled={busy || !mappedAny || (a.liveBlocked && !a.enabled)} onClick={() => void put({ enabled: true }, c.sending)}>{c.start}</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
