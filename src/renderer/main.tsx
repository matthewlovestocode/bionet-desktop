/**
 * The window's page. It owns nothing of its own: the lab comes from the main process, what is drawn
 * comes from `@biolibs/bionet-panels`, and the colours come from `@biolibs/bionet-theme`. All this
 * file does is join them, by making the bridge to the main process look like any other lab.
 */
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Action, Answer, LabSnapshot, LabSource } from "@biolibs/bionet-client";
import { Adviser, AdviserStrip, LabWindow, Strains, type AdviserSeen } from "@biolibs/bionet-panels";
import { LabProvider, useAct, useLab } from "@biolibs/bionet-react";
import { LabView, type NewPlace, type Standing } from "@biolibs/bionet-scene";
import { Demo, LabAt, stopFor, type ShownAt, type TourStop } from "@biolibs/bionet-demo";
import { InstrumentTool, Tools, moleculeOf, toolFor, useDigestBench, useLigationBench, usePcrBench } from "@biolibs/bionet-tools";
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

/** The adviser's door, kept up with as the main process reports it. */
function useDoor(): [DoorState, (door: DoorState) => void] {
  const [door, setDoor] = useState<DoorState>({ on: false, url: null, seen: [] });
  useEffect(() => {
    void window.bionet.adviser.state().then(setDoor);
    return window.bionet.adviser.onState(setDoor);
  }, []);
  return [door, setDoor];
}

/**
 * The adviser this device hosts: the card where it is let in and its door opened, and the lab with
 * the view following it. The door is the main process's, the card and the strip are the panels' and
 * the scene is the one every tool is shown in; this only passes one to the other.
 */
function AdviserTab({ door, setDoor }: { door: DoorState; setDoor: (door: DoorState) => void }) {
  const lab = useLab()?.lab;
  const [watching, setWatching] = useState(false);
  const [following, setFollowing] = useState(true);
  const [stop, setStop] = useState<TourStop>({ at: "lab", focus: { place: null } });
  const last = door.seen.at(-1) ?? null;
  // The latest thing it did that has a place in the lab. Reading a list has none, and leaves the view where it was.
  const placed = [...door.seen].reverse().find((one) => one.shows !== null && one.shows !== undefined);
  useEffect(() => {
    if (following && placed !== undefined && lab !== null && lab !== undefined) setStop(stopFor(placed.shows as ShownAt, lab));
  }, [placed?.at, placed?.tool, following]);
  if (watching) {
    return (
      <div className="watching">
        <AdviserStrip last={last} following={following} onFollow={setFollowing} onBack={() => setWatching(false)} />
        <LabAt stop={stop} />
      </div>
    );
  }
  return <Adviser onWatch={() => setWatching(true)}
                  door={{ ...door, turn: (on) => window.bionet.adviser.turn(on).then(setDoor), copy: () => window.bionet.adviser.copy(), renew: () => window.bionet.adviser.renew().then(setDoor) }} />;
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
 * Every tool, each in the lab at the machine it is used at. They are all the one scene, so choosing
 * another moves the view from one machine to the next instead of putting a new picture up.
 */
function Bench() {
  // A pair that has been designed and has arrived leads straight on to its PCR, opened on those tubes.
  const [pcrOn, setPcrOn] = useState<PcrTubes | null>(null);
  return <Tools views={{ sequences: <LabAt stop={{ at: "sequences" }} />,
                         assembly: <LabAt stop={{ at: "assembly" }} />,
                         codons: <LabAt stop={{ at: "codons" }} />,
                         verify: <LabAt stop={{ at: "verify" }} />,
                         primers: (go) => <LabAt stop={{ at: "primers" }} onPcr={(tubes) => { setPcrOn(tubes); go("pcr"); }} />,
                         pcr: <LabAt stop={{ at: "pcr", ...(pcrOn === null ? {} : { start: pcrOn }) }} />,
                         digest: <LabAt stop={{ at: "digest" }} />, ligation: <LabAt stop={{ at: "ligation" }} />,
                         induction: <LabAt stop={{ at: "induction" }} /> }} />;
}

/** The window: the lab's own tabs, and the ones this app adds. */
function App() {
  const [door, setDoor] = useDoor();
  const strains = useLab()?.lab?.strains.length ?? 0;
  // Said on the tab while the adviser is at it, so that it is noticed from anywhere in the window.
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((was) => was + 1), 15_000); return () => clearInterval(timer); }, []);
  const latest = door.seen.at(-1);
  const atWork = latest !== undefined && Date.now() - Date.parse(latest.at) < 90_000;
  return (
    <LabWindow tab={location.hash.slice(1) || "freezer"} copy={window.bionet.copy} save={window.bionet.save}
               extra={[{ id: "strains", label: `Strains · ${strains}`, view: <Strains /> },
                       { id: "scene", label: "Lab", view: <Scene /> }, { id: "tools", label: "Tools", view: <Bench /> },
                       { id: "adviser", label: atWork ? "Adviser · at work" : "Adviser", view: <AdviserTab door={door} setDoor={setDoor} /> },
                       { id: "glossary", label: "Glossary", view: <section className="card"><ReviewSheet /></section> },
                       { id: "demo", label: "Demo", view: <Demo /> }]} />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LabProvider source={bridge()}>
      <App />
    </LabProvider>
  </StrictMode>,
);
