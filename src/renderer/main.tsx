/**
 * The window's page. It owns nothing of its own: the lab comes from the main process, what is drawn
 * comes from `@biolibs/bionet-panels`, and the colours come from `@biolibs/bionet-theme`. All this
 * file does is join them, by making the bridge to the main process look like any other lab.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Action, Answer, LabSnapshot, LabSource } from "@biolibs/bionet-client";
import { LabWindow } from "@biolibs/bionet-panels";
import { LabProvider, useAct, useLab } from "@biolibs/bionet-react";
import { LabView } from "@biolibs/bionet-scene";
import "@biolibs/bionet-theme/theme.css";
import "@biolibs/bionet-panels/panels.css";
import "@biolibs/bionet-scene/scene.css";
import "./page.css";

declare global {
  interface Window {
    /** What the preload script lets this page do, and all it lets it do. */
    bionet: {
      state: () => Promise<LabSnapshot>;
      do: (action: Action, payload?: unknown) => Promise<Answer>;
      onState: (listener: (state: LabSnapshot) => void) => () => void;
      copy: (words: string) => Promise<void>;
    };
  }
}

/** The lab in the main process, as the hooks reach it. */
function bridge(): LabSource {
  let current: LabSnapshot | null = null;
  const listeners = new Set<() => void>();
  const take = (state: LabSnapshot): void => {
    current = state;
    for (const listener of listeners) listener();
  };
  void window.bionet.state().then(take);
  window.bionet.onState(take);
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => current,
    act: (action, payload) => window.bionet.do(action, payload),
  };
}

/** The lab drawn in three dimensions, from the same record the other tabs show, and arranged by hand. */
function Scene() {
  const lab = useLab()?.lab;
  const act = useAct();
  if (lab === null || lab === undefined) return null;
  return (
    <div className="scene">
      <LabView lab={lab} name={lab.name ?? "Lab"}
               onStand={(place, standing) => act("standPlace", { place, standing })}
               onAdd={(place) => act("addPlace", place)}
               onRetire={(place) => act("retirePlace", { place })} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LabProvider source={bridge()}>
      <LabWindow tab={location.hash.slice(1) || "freezer"} copy={window.bionet.copy} extra={[{ id: "scene", label: "Lab", view: <Scene /> }]} />
    </LabProvider>
  </StrictMode>,
);
