/**
 * The window's page. It owns nothing of its own: the lab comes from the main process, what is drawn
 * comes from `@biolibs/bionet-panels`, and the colours come from `@biolibs/bionet-theme`. All this
 * file does is join them, by making the bridge to the main process look like any other lab.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Action, Answer, LabSnapshot, LabSource } from "@biolibs/bionet-client";
import { LabWindow } from "@biolibs/bionet-panels";
import { LabProvider, useAct, useLab } from "@biolibs/bionet-react";
import { InstrumentStage, LabView } from "@biolibs/bionet-scene";
import { InstrumentTool, Tools, instrumentFor, toolFor, usePcrBench } from "@biolibs/bionet-tools";
import { ReviewSheet } from "@biolibs/glossary-react";
import "@biolibs/bionet-theme/theme.css";
import "@biolibs/bionet-panels/panels.css";
import "@biolibs/bionet-scene/scene.css";
import "@biolibs/bionet-tools/tools.css";
import "@biolibs/glossary-react/glossary.css";
import "./page.css";

declare global {
  interface Window {
    /** What the preload script lets this page do, and all it lets it do. */
    bionet: {
      state: () => Promise<LabSnapshot>;
      do: (action: Action, payload?: unknown) => Promise<Answer>;
      onState: (listener: (state: LabSnapshot) => void) => () => void;
      copy: (words: string) => Promise<void>;
      save: (name: string, text: string) => Promise<boolean>;
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

/**
 * A PCR at its machine: the thermocycler in a space of its own, with what the tool says beside it.
 * The scene is from one package and the PCR from another; this only puts them together.
 */
function PcrAtMachine({ place, onDone }: { place: string | null; onDone?: () => void }) {
  const lab = useLab()?.lab;
  const found = lab?.places.find((one) => one.place === place);
  const bench = usePcrBench({ instrument: found === undefined ? null : { id: found.place, name: found.name }, ...(onDone === undefined ? {} : { onDone }) });
  return <div className="scene"><InstrumentStage {...bench.stage}>{bench.panel}</InstrumentStage></div>;
}

/**
 * The lab drawn in three dimensions, from the same record the other tabs show. It is arranged by
 * hand there, and pressing an instrument opens the tool for it in the scene's place.
 */
function Scene() {
  const lab = useLab()?.lab;
  const act = useAct();
  const [using, setUsing] = useState<string | null>(null);
  if (lab === null || lab === undefined) return null;
  if (using !== null) {
    return toolFor(lab.places.find((one) => one.place === using)) === "pcr"
      ? <PcrAtMachine place={using} onDone={() => setUsing(null)} />
      : <InstrumentTool place={using} onDone={() => setUsing(null)} />;
  }
  return (
    <div className="scene">
      <LabView lab={lab} name={lab.name ?? "Lab"}
               onStand={(place, standing) => act("standPlace", { place, standing })}
               onAdd={(place) => act("addPlace", place)}
               onRetire={(place) => act("retirePlace", { place })}
               onUse={setUsing} />
    </div>
  );
}

/** Every tool. PCR is shown at a thermocycler: the lab's own if it has placed one, and one that stands alone if not. */
function Bench() {
  const lab = useLab()?.lab;
  if (lab === null || lab === undefined) return null;
  return <Tools views={{ pcr: <PcrAtMachine place={instrumentFor(lab, "pcr")?.id ?? null} /> }} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LabProvider source={bridge()}>
      <LabWindow tab={location.hash.slice(1) || "freezer"} copy={window.bionet.copy} save={window.bionet.save} extra={[{ id: "scene", label: "Lab", view: <Scene /> }, { id: "tools", label: "Tools", view: <Bench /> },
                         { id: "glossary", label: "Glossary", view: <section className="card"><ReviewSheet /></section> }]} />
    </LabProvider>
  </StrictMode>,
);
