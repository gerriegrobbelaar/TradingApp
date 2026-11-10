import { useEffect, type ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  lede,
  tools,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  tools?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Camelthorn Finance`;
  }, [title]);
  return (
    <header className="top">
      <div className="lead">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="h1">{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {tools && <div className="tools">{tools}</div>}
    </header>
  );
}
