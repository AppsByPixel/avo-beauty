import type { MouseEvent, ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';

/**
 * An in-app link to `appointmentHref(…)`. A real `<a href>` — so it is a link to
 * a screen reader, opens in a new tab on a modifier click, and survives being
 * copied — that navigates inside the app on a plain click.
 *
 * `useRouter({ warn: false })` AND NOT `<Link>`: the board's route declares no
 * search schema (its date filter is view state), so a typed `<Link search>` would
 * need one added to the route table for a parameter only the board reads, and
 * the panels that render this are driven in tests without a router. With no
 * router in context the anchor simply behaves as an anchor.
 */
export function AppointmentLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter({ warn: false });
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!router) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.history.push(href);
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
