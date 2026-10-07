import type { ReactNode } from "react";
import { Link } from "../router/Router.tsx";

/** CMS links are "/path" (in-app navigation) or "https://…" (new tab). Anything else is not rendered as a link. */
export function SmartLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (/^\/(?!\/)/.test(href)) return <Link to={href} className={className}>{children}</Link>;
  if (/^https:\/\//.test(href)) return <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}</a>;
  return <span className={className}>{children}</span>;
}
