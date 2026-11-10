import type { InputHTMLAttributes } from "react";

export interface SwitchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange" | "checked"
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible text; also the accessible name. */
  label: string;
}

export function Switch({ checked, onCheckedChange, label, className, ...rest }: SwitchProps) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <input
        {...rest}
        type="checkbox"
        role="switch"
        className={["switch", className ?? ""].filter(Boolean).join(" ")}
        checked={checked}
        onChange={(e) => onCheckedChange(e.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
