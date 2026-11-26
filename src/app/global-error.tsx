"use client";

import { useEffect } from "react";

/** Last-resort boundary for failures in the root layout itself. */
export default function GlobalError({error, reset}: {error: Error & { digest?: string }; reset: () => void}) {
  useEffect(() => {
    console.error(JSON.stringify({level: "error", msg: "global error", digest: error.digest, error: error.message}));
  }, [error]);

  return (
    <html lang="en">
      <body style={{fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: "40rem", margin: "0 auto"}}>
        <h1 style={{fontSize: "1.5rem", fontWeight: 700}}>BizPilot AI is unavailable</h1>
        <p style={{marginTop: "0.75rem", color: "#555"}}>
          The application failed to start this page. Your data is safe — nothing was submitted.
        </p>
        <p style={{marginTop: "0.5rem", fontSize: "0.8rem", color: "#777"}}>Reference: {error.digest ?? "unknown"}</p>
        <button
          onClick={reset}
          style={{marginTop: "1.25rem", padding: "0.5rem 1rem", borderRadius: "0.5rem", background: "#2563eb", color: "white", border: 0, cursor: "pointer"}}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
