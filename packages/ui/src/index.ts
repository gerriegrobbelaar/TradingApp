export const UI_PACKAGE = "@camelthorn/ui";

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./components/Button";
export { Card, type CardProps } from "./components/Card";
export { Chip, type ChipProps, type ChipTone } from "./components/Chip";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./components/Segmented";
export { Sheet, type SheetProps } from "./components/Sheet";
export { Skeleton, type SkeletonProps } from "./components/Skeleton";
export { Stamp, type StampProps } from "./components/Stamp";
export { Switch, type SwitchProps } from "./components/Switch";
export { Toast, type ToastProps } from "./components/Toast";
export { formatAgo } from "./ago";
export {
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeMode,
  readStoredTheme,
  storeTheme,
  type ThemeMode,
} from "./theme";
