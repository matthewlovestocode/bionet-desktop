/**
 * The window: who you are, which lab you are in, and the lab.
 *
 * It holds no state of its own about the lab. The main process sends the lab as it stands, every time
 * it changes, and this draws it; a button asks for one thing to be done and waits to be told how the
 * lab changed. So what is on screen is always what the signed logs say, and never what a form hoped.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { History, Inventory, People, Sharing } from "./views";
import type { PeerView, Snapshot } from "./types";

/** Ask for one thing, and report how it went. */
export type Act = (action: string, payload?: unknown) => Promise<boolean>;

const TABS = ["inventory", "people", "history", "sharing"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (TABS as readonly string[]).includes(location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : "inventory");

  useEffect(() => {
    void window.bionet.state().then(setState);
    return window.bionet.onState(setState);
  }, []);

  const act = useCallback<Act>(async (action, payload) => {
    const answer = await window.bionet.do(action, payload);
    setTrouble(answer.ok ? null : answer.error);
    return answer.ok;
  }, []);

  if (state === null) return <main className="centre"><p className="dim">Opening the lab…</p></main>;

  const problem = trouble === null ? null : (
    <p role="alert" className="trouble">{trouble}<button type="button" className="plain" onClick={() => setTrouble(null)}>dismiss</button></p>
  );

  if (state.device.person === null) return <main className="centre">{problem}<Who act={act} /></main>;
  if (state.lab === null) return <main className="centre">{problem}<NoLab state={state} act={act} /></main>;
  if (!state.lab.member) return <main className="centre">{problem}<Waiting state={state} /></main>;

  const lab = state.lab;
  return (
    <div className="shell">
      <header>
        <div>
          <h1>{lab.name ?? "A lab"}</h1>
          <p className="dim small">{state.device.person} · {lab.keeper ? "keeper" : "member"} · this device <code>{state.device.fingerprint}</code></p>
        </div>
        <Sync peer={state.peer} />
      </header>
      <nav>
        {TABS.map((one) => (
          <button key={one} type="button" className={one === tab ? "tab on" : "tab"} onClick={() => setTab(one)}>
            {one === "inventory" ? `Freezer · ${lab.items.filter((item) => !item.retired).length}`
              : one === "people" ? `People · ${lab.roster.filter((key) => key.removed === null).length}`
              : one === "history" ? `History · ${lab.entries.length}` : "Sharing"}
          </button>
        ))}
      </nav>
      <main>
        {problem}
        {tab === "inventory" && <Inventory lab={lab} act={act} />}
        {tab === "people" && <People state={state} lab={lab} act={act} />}
        {tab === "history" && <History lab={lab} />}
        {tab === "sharing" && <Sharing state={state} lab={lab} act={act} />}
      </main>
    </div>
  );
}

/** How the connection to the lab's peer is going, said the way a person would want to hear it. */
export function Sync({ peer }: { peer: PeerView }) {
  const waiting = peer.pending === 0 ? "" : ` · ${peer.pending} ${peer.pending === 1 ? "change" : "changes"} to send`;
  const words = peer.url === null ? "No peer set · working on this device only"
    : peer.status === "synced" ? "In step with the lab"
    : peer.status === "syncing" ? "Syncing…"
    : peer.status === "connecting" ? `Reaching the lab's peer…${waiting}`
    : peer.status === "waiting" ? "Waiting to be let in"
    : `Offline${waiting}`;
  return (
    <div className="sync" title={peer.problem ?? peer.url ?? ""}>
      <span className={`dot ${peer.url === null ? "offline" : peer.status}`} />
      <span>{words}</span>
    </div>
  );
}

/** A form that asks for one thing and clears itself if it worked. */
export function Ask({ onAsk, children, className }: { onAsk: (data: FormData) => Promise<boolean>; children: ReactNode; className?: string }) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    const ok = await onAsk(new FormData(form));
    setBusy(false);
    if (ok) form.reset();
  };
  return <form className={className} onSubmit={submit} aria-busy={busy}><fieldset disabled={busy}>{children}</fieldset></form>;
}

/** A button that copies some words and says that it did. */
export function Copy({ words, label = "Copy" }: { words: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="quiet" onClick={() => { void window.bionet.copy(words).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? "Copied" : label}
    </button>
  );
}

function Who({ act }: { act: Act }) {
  return (
    <section className="card narrow">
      <h1>Who is at this device?</h1>
      <p className="dim">Every change you make is signed by a key made on this device, and shown to your lab under this name. The key never leaves this computer.</p>
      <Ask onAsk={(data) => act("setPerson", String(data.get("name") ?? ""))} className="row">
        <input name="name" placeholder="Your name" autoFocus required maxLength={200} />
        <button type="submit">Continue</button>
      </Ask>
    </section>
  );
}

function DeviceKey({ state }: { state: Snapshot }) {
  return (
    <div className="keybox">
      <div><span className="label">This device's key</span><Copy words={state.device.key} label="Copy key" /></div>
      <code className="wrap">{state.device.key}</code>
      <p className="dim small">Fingerprint <code>{state.device.fingerprint}</code>. It is safe to send: it lets a lab recognise this device, and nothing else.</p>
    </div>
  );
}

function NoLab({ state, act }: { state: Snapshot; act: Act }) {
  return (
    <div className="pair">
      <section className="card">
        <h2>Found a lab</h2>
        <p className="dim">You become its first keeper. It works on this device straight away, with or without a network.</p>
        <Ask onAsk={(data) => act("found", { name: String(data.get("name") ?? ""), peer: String(data.get("peer") ?? "") })} className="stack">
          <label>What is it called?<input name="name" placeholder="The Wren Lab" required maxLength={200} /></label>
          <label><span>Its web peer, if it has one (optional)</span><input name="peer" placeholder="wss://your-lab.example/sync" /></label>
          <button type="submit">Found the lab</button>
        </Ask>
      </section>
      <section className="card">
        <h2>Join a lab</h2>
        <p className="dim">Send a keeper this device's key, and paste the invitation they send back. The lab arrives once they have added you.</p>
        <DeviceKey state={state} />
        <Ask onAsk={(data) => act("join", String(data.get("invite") ?? ""))} className="stack">
          <label>Invitation<input name="invite" placeholder="wss://your-lab.example/sync#…" required /></label>
          <button type="submit">Join</button>
        </Ask>
      </section>
    </div>
  );
}

function Waiting({ state }: { state: Snapshot }) {
  return (
    <section className="card narrow">
      <h1>Waiting to be let in</h1>
      <p>This device has asked to join a lab, and none of the lab has been sent to it yet. A keeper has to add this device's key, and then it arrives on its own.</p>
      <DeviceKey state={state} />
      <Sync peer={state.peer} />
      {state.peer.problem !== null && <p className="dim small">{state.peer.problem}</p>}
    </section>
  );
}
