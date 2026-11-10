import { PageHeader } from "../components/PageHeader";
import { groupLabel } from "../routes";

export function ComingSoon({ path, title }: { path: string; title: string }) {
  return (
    <PageHeader
      eyebrow={groupLabel(path) ?? "Camelthorn Finance"}
      title={title}
      lede="This screen is not built yet. It arrives in a later phase."
    />
  );
}

export function NotFound() {
  return (
    <PageHeader
      eyebrow="Not found"
      title="Page not found"
      lede="Check the address, or use the menu above."
    />
  );
}
