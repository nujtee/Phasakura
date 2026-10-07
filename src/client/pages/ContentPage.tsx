import { EmptyState } from "../components/EmptyState.tsx";

/**
 * Generic page shell for pages whose content module ships in a later phase
 * (Gallery CMS, Booking flow, History CMS).
 */
export function ContentPage({ title }: { title: string }) {
  return (
    <section className="page container" aria-labelledby="page-title">
      <h1 id="page-title" className="page__title">
        {title}
      </h1>
      <EmptyState />
    </section>
  );
}
