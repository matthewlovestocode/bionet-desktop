/** The four things a member looks at: the freezer, the people, the history, and what the world is shown. */
import { useState } from "react";
import { Ask, Copy, type Act } from "./App";
import type { Entry, Item, LabView, Part, Snapshot } from "./types";

const whole = (data: FormData, name: string): number => Number(String(data.get(name) ?? "").trim());
const short = (id: string): string => `${id.slice(0, 10)}…`;
const amountOf = (item: Item): string => `${item.amount}${item.unit === null ? "" : ` ${item.unit}`}`;

export function Inventory({ lab, act }: { lab: LabView; act: Act }) {
  return (
    <>
      {lab.parts.length === 0 && <p className="empty">Nothing in the freezer yet. Add the first part below.</p>}
      {lab.parts.map((part) => <PartCard key={part.checksum} part={part} items={lab.items.filter((item) => item.part === part.checksum)} act={act} />)}
      <section className="card">
        <h2>Add a part</h2>
        <p className="dim small">A part is a molecule, known by the checksum of its sequence. Two people adding the same sequence get the same part, whatever each calls it.</p>
        <Ask onAsk={(data) => act("addPart", { name: String(data.get("name") ?? ""), sequence: String(data.get("sequence") ?? ""), circular: data.get("circular") === "on" })} className="stack">
          <label>Name<input name="name" placeholder="pUC19" required maxLength={200} /></label>
          <label>Sequence<textarea name="sequence" placeholder="GGATCACAGTCTACACTGCTCACTCC…" required rows={3} spellCheck={false} /></label>
          <label className="check"><input type="checkbox" name="circular" /> It is a circle</label>
          <button type="submit">Add part</button>
        </Ask>
      </section>
    </>
  );
}

function PartCard({ part, items, act }: { part: Part; items: Item[]; act: Act }) {
  const live = items.filter((item) => !item.retired);
  return (
    <section className="card part">
      <div className="parthead">
        <div>
          <h2>{part.name}</h2>
          <p className="dim small">{part.length} bp{part.circular ? " · circular" : ""} · <code>{part.checksum.slice(0, 26)}…</code></p>
        </div>
        <label className="check" title="Whether other labs are told this part can be asked for">
          <input type="checkbox" checked={part.offered} onChange={(event) => void act("offer", { part: part.checksum, available: event.target.checked })} />
          On offer to other labs
        </label>
      </div>
      {live.length === 0 ? <p className="dim small">No tubes of this.</p> : (
        <table>
          <thead><tr><th>Tube</th><th>Amount</th><th>Use or add</th><th>Count</th><th /></tr></thead>
          <tbody>{live.map((item) => <ItemRow key={item.item} item={item} act={act} />)}</tbody>
        </table>
      )}
      <Ask onAsk={(data) => act("addItem", { part: part.checksum, amount: whole(data, "amount"), unit: String(data.get("unit") ?? "") })} className="row tight">
        <input name="amount" type="number" min={0} step={1} placeholder="Amount" required />
        <input name="unit" placeholder="Unit, e.g. µL" maxLength={20} />
        <button type="submit" className="quiet">Add a tube</button>
      </Ask>
    </section>
  );
}

function ItemRow({ item, act }: { item: Item; act: Act }) {
  return (
    <tr className={item.needsRecount ? "flagged" : undefined}>
      <td><code>{short(item.item)}</code></td>
      <td>
        <strong>{amountOf(item)}</strong>
        {item.needsRecount && <span className="badge" title="The log has lost track of this tube: it went below zero, or two people counted it at once.">needs a count</span>}
      </td>
      <td>
        <div className="row tight">
          <button type="button" className="quiet" onClick={() => void act("adjust", { item: item.item, by: -1 })}>−1</button>
          <button type="button" className="quiet" onClick={() => void act("adjust", { item: item.item, by: 1 })}>+1</button>
          <Ask onAsk={(data) => act("adjust", { item: item.item, by: whole(data, "by") })} className="row tight">
            <input name="by" type="number" step={1} placeholder="±" required className="num" aria-label="Change by" />
            <button type="submit" className="quiet">Apply</button>
          </Ask>
        </div>
      </td>
      <td>
        <Ask onAsk={(data) => act("recount", { item: item.item, amount: whole(data, "amount") })} className="row tight">
          <input name="amount" type="number" min={0} step={1} placeholder="There is" required className="num" aria-label="Amount there is" />
          <button type="submit" className="quiet">Set</button>
        </Ask>
      </td>
      <td><button type="button" className="plain" onClick={() => void act("retire", { item: item.item })}>retire</button></td>
    </tr>
  );
}

export function People({ state, lab, act }: { state: Snapshot; lab: LabView; act: Act }) {
  return (
    <>
      <section className="card">
        <h2>Who is in the lab</h2>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Device</th><th /></tr></thead>
          <tbody>
            {lab.roster.map((one) => (
              <tr key={one.key} className={one.removed === null ? undefined : "gone"}>
                <td>{one.person}{one.you && <span className="badge calm">this device</span>}</td>
                <td>{one.removed !== null ? "removed" : one.founder ? "keeper · founder" : one.role}</td>
                <td><code>{one.fingerprint}</code></td>
                <td>{one.removed !== null && <span className="dim small">log kept up to entry {one.removed.cutoff + 1}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dim small">A device is known by its key. One person with two computers appears twice, once for each.</p>
      </section>
      {lab.keeper ? (
        <section className="card">
          <h2>Add somebody</h2>
          <p className="dim small">Ask them for their device's key, add it here, and send them the invitation. Their app fills in once this change has reached the lab's peer.</p>
          <Ask onAsk={(data) => act("addMember", { key: String(data.get("key") ?? ""), person: String(data.get("person") ?? ""), role: String(data.get("role") ?? "member") })} className="stack">
            <label>Their device's key<input name="key" placeholder="43 letters and digits" required spellCheck={false} /></label>
            <label>Their name<input name="person" required maxLength={200} /></label>
            <label>As<select name="role"><option value="member">a member, who can change the freezer</option><option value="keeper">a keeper, who can also change who is in the lab</option></select></label>
            <button type="submit">Add to the lab</button>
          </Ask>
          {state.peer.invite !== null ? (
            <div className="keybox">
              <div><span className="label">Invitation to send them</span><Copy words={state.peer.invite} label="Copy invitation" /></div>
              <code className="wrap">{state.peer.invite}</code>
            </div>
          ) : <p className="dim small">Set the lab's web peer under Sharing to have an invitation to send.</p>}
        </section>
      ) : <p className="dim small">Only a keeper can change who is in the lab.</p>}
    </>
  );
}

/** What one change was, in words. */
function describe(entry: Entry, lab: LabView): string {
  const op = entry.op;
  const part = (checksum: unknown): string => lab.parts.find((one) => one.checksum === checksum)?.name ?? "a part";
  const tube = (id: unknown): string => {
    const item = lab.items.find((one) => one.item === id);
    return item === undefined ? "a tube" : `a tube of ${part(item.part)}`;
  };
  const unit = (id: unknown): string => lab.items.find((one) => one.item === id)?.unit ?? "";
  switch (op.type) {
    case "roster.found": return `founded ${String(op["name"])}`;
    case "roster.add": return `added ${String(op["person"])} as a ${String(op["role"])}`;
    case "roster.remove": return `removed ${lab.roster.find((one) => one.key === op["key"])?.person ?? "a device"}`;
    case "roster.role": return `made ${lab.roster.find((one) => one.key === op["key"])?.person ?? "a device"} a ${String(op["role"])}`;
    case "part.add": return `added the part ${String(op["name"])}`;
    case "part.offer": return `${op["available"] === true ? "put" : "took"} ${part(op["part"])} ${op["available"] === true ? "on" : "off"} offer`;
    case "item.add": return `added ${tube(op["item"])}, ${String(op["amount"])} ${String(op["unit"] ?? "")}`.trim();
    case "item.adjust": return `${Number(op["by"]) < 0 ? "used" : "added"} ${Math.abs(Number(op["by"]))} ${unit(op["item"])} ${Number(op["by"]) < 0 ? "of" : "to"} ${tube(op["item"])}`.replace(/\s+/g, " ");
    case "item.recount": return `counted ${String(op["amount"])} ${unit(op["item"])} in ${tube(op["item"])}`.replace(/\s+/g, " ");
    case "item.retire": return `retired ${tube(op["item"])}`;
    case "field.set": return `set ${String(op["field"])} to ${String(op["value"])}`;
    default: return `did something this version does not know (${op.type})`;
  }
}

export function History({ lab }: { lab: LabView }) {
  const [all, setAll] = useState(false);
  const newest = [...lab.entries].reverse();
  const shown = all ? newest : newest.slice(0, 40);
  return (
    <section className="card">
      <h2>Everything that has happened</h2>
      <p className="dim small">Each line is one signed change. The time is what the signer's computer said, which is a claim; the order is worked out from what each person had seen.</p>
      {lab.overlaps.length > 0 && <p className="note">{lab.overlaps.length} {lab.overlaps.length === 1 ? "pair of changes was" : "pairs of changes were"} made without knowledge of each other. One of each stood; both are below.</p>}
      {lab.waiting > 0 && <p className="note">{lab.waiting} {lab.waiting === 1 ? "change is" : "changes are"} waiting on others that have not arrived yet.</p>}
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th /></tr></thead>
        <tbody>
          {shown.map((entry) => (
            <tr key={entry.id} className={entry.status === "applied" ? undefined : "gone"}>
              <td className="dim nowrap">{new Date(entry.signed_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
              <td>{entry.signer ?? lab.roster.find((one) => one.key === entry.author)?.person ?? "unknown"}</td>
              <td>{describe(entry, lab)}</td>
              <td>{entry.status !== "applied" && <span className="badge" title={entry.reason ?? ""}>{entry.status}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!all && newest.length > shown.length && <button type="button" className="quiet" onClick={() => setAll(true)}>Show all {newest.length}</button>}
    </section>
  );
}

export function Sharing({ state, lab, act }: { state: Snapshot; lab: LabView; act: Act }) {
  const [said, setSaid] = useState<string | null>(null);
  const inStock = new Set(lab.items.filter((item) => !item.retired && item.amount > 0).map((item) => item.part));
  const listed = lab.parts.filter((part) => inStock.has(part.checksum));
  const publish = async () => {
    setSaid("Publishing…");
    const answer = await window.bionet.do("publish");
    const result = answer.ok ? (answer.result as { ok: boolean; reason: string | null; parts: number }) : { ok: false, reason: answer.error, parts: 0 };
    setSaid(result.ok ? `Published: ${result.parts} ${result.parts === 1 ? "part" : "parts"}, signed by this device.` : `Not published. ${result.reason ?? ""}`);
  };
  return (
    <>
      <section className="card">
        <h2>What other labs are shown</h2>
        <p className="dim small">Only this: which parts the lab has in stock, and whether each can be asked for. Tubes, amounts and who did what stay inside the lab.</p>
        {listed.length === 0 ? <p className="dim">Nothing would be listed: no part has a tube with anything in it.</p> : (
          <table>
            <thead><tr><th>Part</th><th>Length</th><th>Other labs may ask for it</th></tr></thead>
            <tbody>{listed.map((part) => <tr key={part.checksum}><td>{part.name}</td><td>{part.length} bp</td><td>{part.offered ? "yes" : "no"}</td></tr>)}</tbody>
          </table>
        )}
        <div className="row">
          <button type="button" onClick={() => void publish()} disabled={state.peer.url === null}>Publish this</button>
          {said !== null && <span className="small">{said}</span>}
        </div>
        <p className="dim small">
          {state.peer.origin === null ? "Set the lab's web peer below to have somewhere to publish." : <>Published at <code>{state.peer.origin}/.well-known/bionet.json</code>, signed by this device's key.</>}
          {state.published !== null && <> Last published from this device {new Date(state.published).toLocaleString()}.</>}
        </p>
      </section>
      <section className="card">
        <h2>The lab's web peer</h2>
        <p className="dim small">A server at the lab's address that holds a copy of the lab and passes changes between members who are never online together. It has no key, so it cannot change anything.</p>
        <Ask onAsk={(data) => act("setPeer", String(data.get("peer") ?? ""))} className="row">
          <input name="peer" placeholder="wss://your-lab.example/sync" defaultValue={state.peer.url ?? ""} spellCheck={false} />
          <button type="submit" className="quiet">Use this peer</button>
        </Ask>
        {state.peer.problem !== null && <p className="note">{state.peer.problem}</p>}
        <div className="keybox">
          <div><span className="label">This lab's ID</span>{lab.id !== null && <Copy words={lab.id} label="Copy ID" />}</div>
          <code className="wrap">{lab.id}</code>
          <p className="dim small">Whoever runs the lab's peer sets this as <code>BIONET_LAB</code>, so that it serves this lab and no other.</p>
        </div>
      </section>
    </>
  );
}
