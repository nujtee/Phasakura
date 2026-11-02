import { useEffect, useState } from "react";
import { formatBaht } from "../../../shared/booking-rules.ts";
import type { DashboardDto, OtaStayDto, StayAction, StayRowDto } from "../../../shared/dashboard-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { BookingStatusBadge, PaymentBadge, staysText } from "../bookings/shared.tsx";
import { StayButtons } from "../bookings/StayButtons.tsx";
import { Alert, errorMessage, useDateFormatter } from "../ui.tsx";

/** Figures that come from the GA4 Data API; the rest is counted in D1. */
const GA4_KPIS = ["visitors", "pageViews", "accommodationViews", "bookingStarted", "checkoutStarted"] as const;

/** Dashboard (spec §48). Every figure comes from D1; widgets follow the viewer's permissions. */
export function DashboardPage() {
  const { t, c, me, locale, can, href } = useAdmin();
  const [data, setData] = useState<DashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [stayMsg, setStayMsg] = useState<string | null>(null);
  const [otaOpen, setOtaOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<DashboardDto>("/api/admin/dashboard", controller.signal)
      .then(setData)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [t, version]);

  // Check in / out / no-show from the arrivals and departures lists: the counts change too, so reload.
  const stayChanged = (message: string) => {
    setStayMsg(message);
    setVersion((v) => v + 1);
  };

  const baht = (n: number) => formatBaht(n, locale.code);
  const dateFmt = new Intl.DateTimeFormat(locale.code, { dateStyle: "full", timeZone: "UTC" });
  const shortDay = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", timeZone: "UTC" });
  const num = new Intl.NumberFormat(locale.code);
  const dateTime = useDateFormatter();

  return (
    <section>
      <div className="adm-pagehead">
        <div>
          <h1 className="adm-h1">{format(t.dashboard.welcome, { name: me?.displayName ?? "" })}</h1>
          <p className="adm-muted">{data ? format(c.dash.asOf, { date: dateFmt.format(new Date(`${data.date}T00:00:00Z`)) }) : t.dashboard.intro}</p>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <ul className="adm-kpis" aria-label={c.dash.title}>
            <Kpi label={c.dash.checkInsToday} value={num.format(data.counts.checkInsToday)} />
            <Kpi label={c.dash.checkOutsToday} value={num.format(data.counts.checkOutsToday)} />
            <Kpi label={c.dash.inHouse} value={num.format(data.counts.inHouse)} />
            <Kpi label={c.dash.bookingsToday} value={num.format(data.counts.bookingsCreatedToday)} sub={`${c.dash.bookingsMonth}: ${num.format(data.counts.bookingsCreatedMonth)}`} />
            <Kpi label={c.dash.pendingPayment} value={num.format(data.counts.pendingPayment)} tone={data.counts.pendingPayment ? "warn" : undefined}
              sub={data.money ? `${c.dash.pendingAmount}: ${baht(data.money.pendingPaymentSatang)}` : undefined}
              to={can("bookings.view") ? `${href("bookings")}?payment=UNPAID` : undefined} />
            <Kpi label={c.dash.slipsToReview} value={num.format(data.counts.slipsToReview)} tone={data.counts.slipsToReview ? "warn" : undefined}
              to={can("slips.view") ? href("slips") : undefined} />
            {/* Deposit plan: the rest still to receive — at check-in, or transferred by the guest before the stay. */}
            <Kpi label={c.dash.balanceDue}
              value={data.money ? baht(data.money.balanceDueSatang) : num.format(data.counts.balanceDue)}
              sub={data.money ? format(c.dash.balanceDueSub, { n: num.format(data.counts.balanceDue) }) : undefined}
              to={can("bookings.view") ? `${href("bookings")}?due=1` : undefined} />
            <Kpi label={c.dash.availableHouses} value={num.format(data.inventory.houses.available)} sub={format(c.dash.ofTotal, { total: data.inventory.houses.total })} />
            <Kpi label={c.dash.availableVip} value={num.format(data.inventory.vip.available)} sub={format(c.dash.ofTotal, { total: data.inventory.vip.total })} />
            <Kpi label={c.dash.campingUsed} value={data.inventory.camping.enabled ? num.format(data.inventory.camping.used) : c.dash.campingOff}
              sub={data.inventory.camping.enabled ? format(c.dash.ofTotal, { total: data.inventory.camping.max }) : undefined} />
            <Kpi label={c.dash.campingRemaining} value={data.inventory.camping.enabled ? num.format(data.inventory.camping.remaining) : c.dash.campingOff} />
            {/* OTA bookings (iCal calendars + Channex): the tile opens the table below. */}
            {data.ota && (
              <li className={`adm-kpi adm-kpi--toggle${otaOpen ? " adm-kpi--open" : ""}`}>
                <button type="button" className="adm-kpi__button" aria-expanded={otaOpen} aria-controls="dash-ota"
                  onClick={() => setOtaOpen((o) => !o)}>
                  <span className="adm-kpi__label">{c.dash.otaTitle}</span>
                  <strong className="adm-kpi__value">{num.format(data.ota.stays.length)}</strong>
                  <span className="adm-kpi__sub">{format(c.dash.otaSub, { n: num.format(data.ota.tonight) })}</span>
                  <svg className="adm-kpi__chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                    <path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="visually-hidden">{otaOpen ? c.dash.otaHide : c.dash.otaShow}</span>
                </button>
              </li>
            )}
          </ul>
          {data.ota && otaOpen && <OtaTable id="dash-ota" stays={data.ota.stays} today={data.date} />}

          {data.money && (
            <div className="adm-card">
              <h2 className="adm-h2">{c.dash.revenueTitle}</h2>
              <div className="adm-revenue">
                {([["revenueToday", data.money.today], ["revenueMonth", data.money.month]] as const).map(([k, r]) => (
                  <dl key={k} className="adm-revenue__col">
                    <dt className="adm-h3">{c.dash[k]}</dt>
                    <dd><span className="adm-muted">{c.dash.accommodation}</span> <strong>{baht(r.accommodationSatang)}</strong></dd>
                    <dd><span className="adm-muted">{c.dash.food}</span> <strong>{baht(r.foodSatang)}</strong></dd>
                    <dd className="adm-revenue__total"><span>{c.dash.total}</span> <strong>{baht(r.totalSatang)}</strong></dd>
                  </dl>
                ))}
              </div>
              <h3 className="adm-h3">{c.dash.trend}</h3>
              <Trend data={data.money.trend} label={(d) => shortDay.format(new Date(`${d}T00:00:00Z`))} baht={baht}
                bookings={(n) => format(c.dash.trendBookings, { n })} />
            </div>
          )}

          {stayMsg && <Alert kind="success">{stayMsg}</Alert>}
          {data.arrivals && data.departures && (
            <div className="adm-grid2 adm-grid2--gap">
              <StayList title={c.dash.arrivals} empty={c.dash.noArrivals} rows={data.arrivals} only={["check-in", "no-show"]} onStay={stayChanged} />
              <StayList title={c.dash.departures} empty={c.dash.noDepartures} rows={data.departures} only={["check-out"]} onStay={stayChanged} />
            </div>
          )}

          <div className="adm-card">
            <h2 className="adm-h2">{c.dash.analytics}</h2>
            <ul className="adm-kpis adm-kpis--small">
              {([
                ["visitors", data.analytics.visitors], ["pageViews", data.analytics.pageViews],
                ["accommodationViews", data.analytics.accommodationViews], ["bookingStarted", data.analytics.bookingStarted],
                ["checkoutStarted", data.analytics.checkoutStarted], ["searches", data.analytics.searches],
                ["bookingsCreated", data.analytics.bookingsCreated], ["paymentSubmitted", data.analytics.paymentSubmitted],
                ["confirmedBookings", data.analytics.confirmedBookings], ["foodOrders", data.analytics.foodOrders],
              ] as const).map(([k, v]) => {
                const fromGa4 = (GA4_KPIS as readonly string[]).includes(k);
                const sub = !fromGa4 ? undefined
                  : data.analytics.ga4.status === "NOT_CONFIGURED" ? c.dash.ga4NotConnected
                    : v === null ? c.dash.ga4Error : c.dash.fromGa4;
                return <Kpi key={k} label={c.dash[k]} value={v === null ? "—" : num.format(v)} sub={sub} />;
              })}
              {data.analytics.revenueSatang !== null && <Kpi label={c.dash.revenue} value={baht(data.analytics.revenueSatang)} />}
            </ul>
            {data.analytics.ga4.fetchedAt && (
              <p className="adm-small adm-muted">
                {format(c.dash.ga4Updated, { time: dateTime(data.analytics.ga4.fetchedAt) })}
                {data.analytics.ga4.status === "ERROR" && ` · ${c.dash.ga4Error}`}
              </p>
            )}
            <p className="adm-small adm-muted">{c.dash.analyticsNote} {c.dash.restricted}</p>
          </div>

          <div className="adm-grid2 adm-grid2--gap adm-grid2--tables">
            <div className="adm-card" data-testid="booking-sources">
              <h2 className="adm-h2">{c.dash.bookingSourcesTitle}</h2>
              {data.analytics.bookingSources.length === 0 ? <p className="adm-muted">{c.dash.noSources}</p> : (
                <div className="adm-tablewrap">
                  <table className="adm-table">
                    <thead>
                      <tr>
                        <th scope="col">{c.dash.colSource}</th>
                        <th scope="col" className="adm-num">{c.dash.colBookings}</th>
                        <th scope="col" className="adm-num">{c.dash.colConfirmed}</th>
                        {data.analytics.revenueSatang !== null && <th scope="col" className="adm-num">{c.dash.colRevenue}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.analytics.bookingSources.map((r) => (
                        <tr key={`${r.source}/${r.medium}`}>
                          <td>{r.medium ? `${r.source} / ${r.medium}` : r.source}</td>
                          <td className="adm-num">{num.format(r.bookings)}</td>
                          <td className="adm-num">{num.format(r.confirmed)}</td>
                          {r.revenueSatang !== null && <td className="adm-num">{baht(r.revenueSatang)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="adm-small adm-muted">{c.dash.bookingSourcesNote}</p>
            </div>
            {data.analytics.channels && (
              <div className="adm-card" data-testid="ga4-channels">
                <h2 className="adm-h2">{c.dash.channelsTitle}</h2>
                <div className="adm-tablewrap">
                  <table className="adm-table">
                    <thead>
                      <tr>
                        <th scope="col">{c.dash.colChannel}</th>
                        <th scope="col" className="adm-num">{c.dash.colSessions}</th>
                        <th scope="col" className="adm-num">{c.dash.colUsers}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.analytics.channels.map((r) => (
                        <tr key={r.name}>
                          <td>{r.name}</td>
                          <td className="adm-num">{num.format(r.sessions)}</td>
                          <td className="adm-num">{num.format(r.users)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** OTA stays not over yet: channel, unit, dates, guest (Channex only) and what staff must do. */
function OtaTable({ id, stays, today }: { id: string; stays: OtaStayDto[]; today: string }) {
  const { c, locale, can, href } = useAdmin();
  const day = new Intl.DateTimeFormat(locale.code, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const d = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));
  const channel = (s: OtaStayDto) => s.source === "CHANNEX" ? s.channel
    : ({ BOOKING: "Booking.com", AGODA: "Agoda", AIRBNB: "Airbnb", VRBO: "Vrbo" } as Record<string, string>)[s.channel] ?? (s.label || c.dash.otaOther);
  const money = (s: OtaStayDto) => s.amountMinor === null || !s.currency ? null
    : new Intl.NumberFormat(locale.code, { style: "currency", currency: s.currency, maximumFractionDigits: 0 }).format(s.amountMinor / 100);
  return (
    <div className="adm-card" id={id} data-testid="ota-stays">
      <div className="adm-pagehead">
        <h2 className="adm-h2">{c.dash.otaTableTitle}</h2>
        {can("channels.view") && <Link to={href("channels")} className="adm-small">{c.dash.otaManage}</Link>}
      </div>
      {stays.length === 0 ? <p className="adm-muted">{c.dash.otaNone}</p> : (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{c.dash.otaChannel}</th>
                <th scope="col">{c.dash.otaUnit}</th>
                <th scope="col">{c.dash.otaStay}</th>
                <th scope="col" className="adm-num">{c.dash.otaNights}</th>
                <th scope="col">{c.dash.otaGuest}</th>
                <th scope="col">{c.dash.otaStatus}</th>
              </tr>
            </thead>
            <tbody>
              {stays.map((s, i) => {
                const now = s.checkIn <= today && s.checkOut > today;
                return (
                  <tr key={i}>
                    <td className="adm-table__primary">{channel(s)}</td>
                    <td>{s.units || "—"}</td>
                    <td className="adm-nowrap">{d(s.checkIn)} → {d(s.checkOut)}</td>
                    <td className="adm-num">{s.nights}</td>
                    <td>
                      {s.source === "ICAL" ? <span className="adm-muted adm-small">{c.dash.otaIcal}</span> : (
                        <>
                          {s.guestName ?? "—"}
                          {money(s) && <div className="adm-small adm-muted">{money(s)}</div>}
                          {s.bookingCode && can("bookings.view") && (
                            <div className="adm-small"><Link to={href("bookings", s.bookingCode)} translate="no">{s.bookingCode}</Link></div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {s.status === "CONFLICT" ? <span className="adm-badge adm-badge--warning">{c.dash.otaConflict}</span>
                        : s.status === "UNMAPPED" ? <span className="adm-badge adm-badge--warning">{c.dash.otaUnmapped}</span>
                          : <span className={`adm-badge ${now ? "adm-badge--active" : "adm-badge--muted"}`}>{now ? c.dash.otaTonight : c.dash.otaActive}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone, to }: { label: string; value: string; sub?: string; tone?: "warn"; to?: string }) {
  const body = (
    <>
      <span className="adm-kpi__label">{label}</span>
      <strong className="adm-kpi__value">{value}</strong>
      {sub && <span className="adm-kpi__sub">{sub}</span>}
    </>
  );
  return <li className={`adm-kpi${tone ? ` adm-kpi--${tone}` : ""}`}>{to ? <Link to={to} className="adm-kpi__link">{body}</Link> : body}</li>;
}

/** Accessible bar chart: a table with proportional bars (no chart library, no canvas). */
function Trend({ data, label, baht, bookings }: {
  data: { date: string; bookings: number; revenueSatang: number }[];
  label: (d: string) => string;
  baht: (n: number) => string;
  bookings: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.bookings));
  return (
    <div className="adm-trend" role="table">
      {data.map((d) => (
        <div key={d.date} className="adm-trend__col" role="row" title={`${label(d.date)} · ${bookings(d.bookings)} · ${baht(d.revenueSatang)}`}>
          <span className="adm-trend__bar" role="cell" aria-label={`${label(d.date)}: ${bookings(d.bookings)}, ${baht(d.revenueSatang)}`}
            style={{ height: `${Math.round((d.bookings / max) * 100)}%` }} />
          <span className="adm-trend__n" aria-hidden="true">{d.bookings}</span>
          <span className="adm-trend__label" aria-hidden="true">{label(d.date)}</span>
        </div>
      ))}
    </div>
  );
}

function StayList({ title, empty, rows, only, onStay }: {
  title: string; empty: string; rows: StayRowDto[]; only: StayAction[]; onStay: (message: string) => void;
}) {
  const { t, c, href, locale } = useAdmin();
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{title} ({rows.length})</h2>
      {rows.length === 0 ? <p className="adm-muted">{empty}</p> : (
        <ul className="adm-staylist">
          {rows.map((r) => (
            <li key={r.bookingCode}>
              <Link to={href("bookings", r.bookingCode)} className="adm-mono">{r.bookingCode}</Link>
              <span>{r.customerName}</span>
              <span className="adm-muted">{(r.stays?.length ?? 0) > 1 ? staysText(r.stays, (n) => `× ${n}`).replace(/ · ×/g, " ×") : `${r.itemName}${r.itemType === "OWN_TENT" ? ` × ${r.quantity}` : ""}`}{r.tarps > 0 ? ` + ${t.bk.tarp}` : ""} · {format(c.cal.guests, { adults: r.adults, children: r.children })}</span>
              <span className="adm-row adm-row--wrap"><BookingStatusBadge status={r.status} /> <PaymentBadge status={r.paymentStatus} /> {formatBaht(r.totalSatang, locale.code)}</span>
              <StayButtons compact only={only} code={r.bookingCode} checkIn={r.checkIn} actions={r.stayActions}
                balanceSatang={r.status === "CONFIRMED" ? r.balanceSatang : 0} onDone={(_, message) => onStay(message)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
