import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/** The empty page canvas shown while a guard waits for data or a redirect. */
export function BlankPage() {
  return <div aria-busy className="min-h-svh bg-page" />;
}

/**
 * Replaces the current history entry with `href` once. The router's `<Navigate>` fires again
 * whenever its parent re-renders during the pending navigation, which loops inside guard layouts.
 */
export function Redirect({ href }: { readonly href: string }) {
  const navigate = useNavigate();
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;

    sent.current = true;
    void navigate({ href, replace: true });
  }, [href, navigate]);

  return <BlankPage />;
}
