import { splitPhones, telHref } from "../../shared/phones.ts";

/** Every number of the site's contact phone as its own tap-to-call link ("a, b"). */
export function PhoneLinks({ value }: { value: string }) {
  return <>{splitPhones(value).flatMap((phone, i) => [i > 0 ? ", " : null, <a key={`${phone}|${i}`} href={telHref(phone)}>{phone}</a>])}</>;
}
