/**
 * The window's page. It owns nothing of its own: the lab comes from the main process, what is drawn
 * comes from `@biolibs/bionet-panels`, and the colours come from `@biolibs/bionet-theme`. All this
 * file does is join them, by making the bridge to the main process look like any other lab.
 */
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Action, Answer, LabSnapshot, LabSource } from "@biolibs/bionet-client";
import { Adviser, LabWindow, type AdviserSeen } from "@biolibs/bionet-panels";
import { LabProvider, useAct, useLab } from "@biolibs/bionet-react";
import { InstrumentStage, LabView, type NewPlace, type Standing } from "@biolibs/bionet-scene";
import { Demo } from "@biolibs/bionet-demo";
import { InstrumentTool, SequencesTool, Tools, instrumentFor, moleculeOf, toolFor, useDigestBench, useLigationBench, usePcrBench, usePrimerBench } from "@biolibs/bionet-tools";
import { ReviewSheet } from "@biolibs/glossary-react";
import "@biolibs/bionet-theme/theme.css";
import "@biolibs/bionet-panels/panels.css";
import "@biolibs/bionet-scene/scene.css";
import "@biolibs/bionet-tools/tools.css";
import "@biolibs/bionet-demo/demo.css";
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
      adviser: {
        state: () => Promise<DoorState>;
        turn: (on: boolean) => Promise<DoorState>;
        copy: () => Promise<boolean>;
        renew: () => Promise<DoorState>;
        onState: (listener: (state: DoorState) => void) => () => void;
      };
      save: (name: string, text: string) => Promise<boolean>;
    };
  }
}

/** The adviser's door as the main process reports it: whether it is open, where, and what came through. */
interface DoorState { on: boolean; url: string | null; seen: AdviserSeen[] }

/**
 * The adviser this device hosts, with the door the main process keeps for it. The door is the main
 * process's and the card is the panels'; this only passes one to the other.
 */
function AdviserTab() {
  const [door, setDoor] = useState<DoorState>({ on: false, url: null, seen: [] });
  useEffect(() => {
    void window.bionet.adviser.state().then(setDoor);
    return window.bionet.adviser.onState(setDoor);
  }, []);
  return <Adviser door={{ ...door, turn: (on) => window.bionet.adviser.turn(on).then(setDoor), copy: () => window.bionet.adviser.copy(), renew: () => window.bionet.adviser.renew().then(setDoor) }} />;
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
 * The lab drawn in three dimensions, from the same record the other tabs show. It is arranged by
 * hand there, and pressing an instrument works it where it stands.
 *
 * Using a machine is not a different window: the room stays, the view walks up to the machine, and
 * the tool for it comes in beside the scene. So every tool is asked for here whether or not it is
 * open, which is what lets the one scene carry on across opening and closing one.
 */
function Scene() {
  const lab = useLab()?.lab;
  const act = useAct();
  const [using, setUsing] = useState<string | null>(null);
  const stood = lab?.places.find((one) => one.place === using);
  const tool = toolFor(stood);
  const at = stood === undefined ? null : { id: stood.place, name: stood.name };
  const leave = (): void => setUsing(null);
  const pcr = usePcrBench({ instrument: tool === "pcr" ? at : null, onDone: leave });
  const digest = useDigestBench({ instrument: tool === "digest" ? at : null, onDone: leave });
  const ligation = useLigationBench({ instrument: tool === "ligation" ? at : null, onDone: leave });
  const bench = tool === "pcr" ? pcr : tool === "digest" ? digest : tool === "ligation" ? ligation : null;
  if (lab === null || lab === undefined) return null;
  // An instrument the app has no tool for still has its record to show, and that is a page of its own.
  if (using !== null && bench === null) return <InstrumentTool place={using} onDone={leave} />;
  const working = using !== null && bench !== null;
  return (
    <div className="scene">
      <LabView lab={lab} name={lab.name ?? "Lab"}
               {...(working ? { focus: { place: using }, using: { place: using, ...bench.stage, panel: bench.panel } } : {
                 onStand: (place: string, standing: Standing | null) => act("standPlace", { place, standing }),
                 onAdd: (place: NewPlace) => act("addPlace", place),
                 onRetire: (place: string) => act("retirePlace", { place }),
                 onUse: setUsing,
               })}
               molecule={(item) => { const part = lab.parts.find((one) => one.checksum === lab.items.find((each) => each.item === item)?.part); return part === undefined ? null : moleculeOf(part); }} />
    </div>
  );
}

/** The tubes a PCR is run from. */
type PcrTubes = { template: string; forward: string; reverse: string };

/**
 * One tool, shown in the lab: the room, with the view gone to the machine the tool is used at and
 * the tool beside it. Every tool is this same thing, so choosing another one moves the camera from
 * one machine to the next instead of putting a new picture up. A tool whose machine the lab has not
 * placed has nowhere in the room to go, and only then is its machine shown standing alone.
 */
function ToolInLab({ tool, onPcr, pcrOn }: {
  tool: "sequences" | "primers" | "pcr" | "digest" | "ligation";
  /** Told the tubes when primers have been designed and somebody goes on to the PCR. */
  onPcr?: (tubes: PcrTubes) => void;
  /** The tubes to open the PCR on, when it was come to from a design. */
  pcrOn?: PcrTubes | null;
}) {
  const lab = useLab()?.lab;
  const found = lab === null || lab === undefined || tool === "sequences" || tool === "primers" ? null : instrumentFor(lab, tool);
  // Kept the same from one draw to the next, so that a tool is not set working again by being looked at.
  const stood = useMemo(() => (found === null ? null : { id: found.id, name: found.name }), [found?.id, found?.name]);
  const pcr = usePcrBench({ instrument: tool === "pcr" ? stood : null, ...(pcrOn === null || pcrOn === undefined ? {} : { start: pcrOn }) });
  // Primers are designed at a desk, so there is no machine to walk to: the room stays, looking at
  // the template's tube, with the pair drawn on the molecule over it.
  const primers = usePrimerBench(onPcr === undefined ? {} : { onPcr });
  const digest = useDigestBench({ instrument: tool === "digest" ? stood : null });
  const ligation = useLigationBench({ instrument: tool === "ligation" ? stood : null });
  if (lab === null || lab === undefined) return null;
  const bench = tool === "pcr" ? pcr : tool === "digest" ? digest : tool === "ligation" ? ligation : null;
  const drawn = lab.places.some((one) => !one.retired);
  if (bench !== null && stood === null) return <div className="scene"><InstrumentStage {...bench.stage}>{bench.panel}</InstrumentStage></div>;
  if (bench === null && !drawn) return tool === "primers" ? <>{primers.panel}</> : <SequencesTool />;
  const desk = tool === "primers" ? primers.desk : null;
  return (
    <div className="scene">
      <LabView lab={lab} name={lab.name ?? "Lab"}
               {...(bench !== null && stood !== null ? { focus: { place: stood.id }, using: { place: stood.id, ...bench.stage, panel: bench.panel } }
                 : desk !== null ? { focus: desk.focus ?? { place: null }, wide: true, beside: primers.panel }
                 : { focus: { place: null }, wide: true, beside: <div className="bionet"><SequencesTool /></div> })}
               molecule={(item) => { if (desk !== null && desk.focus?.item === item && desk.molecule !== null) return desk.molecule; const part = lab.parts.find((one) => one.checksum === lab.items.find((each) => each.item === item)?.part); return part === undefined ? null : moleculeOf(part); }} />
    </div>
  );
}

/** Every tool, each in the lab at the machine it is used at. */
function Bench() {
  // A pair that has been designed and has arrived leads straight on to its PCR, opened on those tubes.
  const [pcrOn, setPcrOn] = useState<PcrTubes | null>(null);
  return <Tools views={{ sequences: <ToolInLab tool="sequences" />,
                         primers: (go) => <ToolInLab tool="primers" onPcr={(tubes) => { setPcrOn(tubes); go("pcr"); }} />,
                         pcr: <ToolInLab tool="pcr" pcrOn={pcrOn} />, digest: <ToolInLab tool="digest" />, ligation: <ToolInLab tool="ligation" /> }} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LabProvider source={bridge()}>
      <LabWindow tab={location.hash.slice(1) || "freezer"} copy={window.bionet.copy} save={window.bionet.save} extra={[{ id: "scene", label: "Lab", view: <Scene /> }, { id: "tools", label: "Tools", view: <Bench /> },
                         { id: "adviser", label: "Adviser", view: <AdviserTab /> },
                         { id: "glossary", label: "Glossary", view: <section className="card"><ReviewSheet /></section> },
                         { id: "demo", label: "Demo", view: <Demo /> }]} />
    </LabProvider>
  </StrictMode>,
);
