import type { Metadata } from "next";

import { safeNext } from "@/access";

export const metadata: Metadata = {
  title: "Accès privé",
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<{ e?: string; next?: string }> };

export default async function AccessPage({ searchParams }: Props) {
  const { e, next } = await searchParams;
  const target = safeNext(next);
  const message =
    e === "1"
      ? "Mot de passe incorrect."
      : e === "config"
        ? "Accès non configuré : ajoute SITE_PASSWORD dans Vercel."
        : null;

  return (
    <main style={styles.main}>
      <form method="post" action="/api/acces" style={styles.card}>
        <div style={styles.logo} aria-hidden>●</div>
        <h1 style={styles.title}>Accès privé</h1>
        <p style={styles.sub}>Ce studio est réservé. Entre le mot de passe pour continuer.</p>
        <input type="hidden" name="next" value={target} />
        <input
          type="password"
          name="password"
          placeholder="Mot de passe"
          autoComplete="current-password"
          autoFocus
          required
          style={styles.input}
        />
        {message ? <p role="alert" style={styles.error}>{message}</p> : null}
        <button type="submit" style={styles.button}>Entrer</button>
      </form>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "#0a0a0b",
    color: "#f4f4f5",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 360,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 28,
    borderRadius: 16,
    background: "#141416",
    border: "1px solid #26262a",
  },
  logo: { fontSize: 22, color: "#d4ff3f", lineHeight: 1 },
  title: { margin: 0, fontSize: 22, fontWeight: 600 },
  sub: { margin: "0 0 8px", fontSize: 14, color: "#a1a1aa", lineHeight: 1.5 },
  input: {
    height: 44,
    padding: "0 14px",
    borderRadius: 10,
    border: "1px solid #33333a",
    background: "#0a0a0b",
    color: "#f4f4f5",
    fontSize: 15,
    outline: "none",
  },
  error: { margin: 0, fontSize: 13, color: "#f87171" },
  button: {
    height: 44,
    borderRadius: 10,
    border: "none",
    background: "#d4ff3f",
    color: "#0a0a0b",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
};
