import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import {
  Card,
  Segmented,
  applyTheme,
  readStoredTheme,
  storeTheme,
  type SegmentedOption,
  type ThemeMode,
} from "@camelthorn/ui";
import { useSignedIn } from "../auth";
import { PageHeader } from "../components/PageHeader";
import { Connections } from "./Connections";
import { Lazy, lazyNamed } from "../components/Lazy";
import { Schedules } from "./Schedules";
import { Users } from "./Users";

const FxRates = lazyNamed(() => import("./FxRates"), "FxRates");
const MatchingSettings = lazyNamed(() => import("./MatchingSettings"), "MatchingSettings");

type Tab = "appearance" | "users" | "connections" | "schedules" | "fx" | "matching";

const THEME_OPTIONS: SegmentedOption<ThemeMode>[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function Appearance() {
  const [mode, setMode] = useState<ThemeMode>(() => readStoredTheme());
  const [saved, setSaved] = useState(true);
  return (
    <Card>
      <h2 className="h2">Theme</h2>
      <p className="lede">Auto follows your system setting.</p>
      <div className="stack-row">
        <Segmented
          label="Theme"
          options={THEME_OPTIONS}
          value={mode}
          onChange={(m) => {
            setMode(m);
            applyTheme(m);
            setSaved(storeTheme(m));
          }}
        />
      </div>
      {!saved && (
        <p role="status" className="notice warn">
          Your browser blocked saving this choice. It applies until you reload the page.
        </p>
      )}
    </Card>
  );
}

export function Settings() {
  const me = useSignedIn();
  const { tab } = useParams();
  const navigate = useNavigate();
  const isAdmin = me.roles.includes("admin");

  const options: SegmentedOption<Tab>[] = [
    { value: "appearance", label: "Appearance" },
    ...(isAdmin ? [{ value: "users" as const, label: "Users" }] : []),
    { value: "connections", label: "Connections" },
    { value: "schedules", label: "Schedules" },
    { value: "fx", label: "FX rates" },
    { value: "matching", label: "Matching" },
  ];
  const current = options.find((o) => o.value === tab)?.value;
  if (!current) return <Navigate to="/settings/appearance" replace />;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        lede="Appearance, people, connections, schedules, exchange rates and bank matching."
      />
      <div className="settings-seg">
        <Segmented
          label="Settings section"
          options={options}
          value={current}
          onChange={(t) => navigate(`/settings/${t}`)}
        />
      </div>
      {current === "appearance" && <Appearance />}
      {current === "users" && <Users />}
      {current === "connections" && <Connections />}
      {current === "schedules" && <Schedules />}
      {current === "fx" && (
        <Lazy>
          <FxRates />
        </Lazy>
      )}
      {current === "matching" && (
        <Lazy>
          <MatchingSettings />
        </Lazy>
      )}
    </>
  );
}
