import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "primary" | "ghost";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    variant === "default" ? "" : variant,
    size === "sm" ? "sm" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls} {...rest} />;
}
