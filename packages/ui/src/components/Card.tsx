import type { HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Element to render; defaults to a section. */
  as?: "div" | "section" | "article";
}

export function Card({ as: Tag = "section", className, ...rest }: CardProps) {
  return <Tag className={["card", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}
