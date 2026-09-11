# Codex desktop and CLI integration capabilities

Research for [Establish Codex desktop and CLI integration capabilities](https://github.com/dungle-scrubs/lucid/issues/254). Produced inline by the parent Codex session on 2026-09-11. No user session was resumed, messaged, or inspected. This is a capability investigation, not a live integration confirmation.

## Finding that changes the design question

**Observed:** the installed Codex CLI exposes a queue command and a shared app-server interface. It is inaccurate to treat Codex as having only headless execution. **Documented:** a loaded thread can outlive its last connected client. Therefore a daemon PID or loaded-thread result cannot establish that the user's interactive client is still open. The design needs evidence about the particular client and the feedback listener, separately from the native thread. Sources: installed CLI 0.154.0, `codex queue --help`, `codex agents --help`, and [app-server, thread lifecycle](https://learn.chatgpt.com/docs/app-server#threads), retrieved 2026-09-11.

## Capability table

| Question | Terminal CLI | Desktop app |
| --- | --- | --- |
| Native identity and folder | **Documented:** SessionStart/common hook fields include session ID and cwd. **Observed:** installed app-server Thread schema contains ID/cwd. Registration with Lucid remains unverified. [Hooks: common input fields](https://learn.chatgpt.com/docs/hooks#common-input-fields); generated schema described below. | **Unverified:** whether an integration installed here can obtain the originating desktop thread ID, its actual folder, and its transport together. The common app-server protocol supplies thread identity, but that does not prove access to the desktop's running instance. [App-server: initialization and thread/resume](https://learn.chatgpt.com/docs/app-server). |
| Connect to an already-running conversation | **Observed:** queue accepts UUID or exact name and an optional remote endpoint. The CLI exposes shared-daemon session browsing and a stdio proxy to an existing control socket. **Unverified:** endpoint discovery and attachment to the particular originating CLI session. Installed `queue`, `agents`, and `app-server proxy` help. | **Unverified:** a supported, discoverable endpoint for the already-running desktop instance was not established. Starting a separate app-server does not demonstrate attachment to that instance. [App-server: transports](https://learn.chatgpt.com/docs/app-server). |
| Busy and idle feedback | **Documented:** app-server has turn/start and turn/steer. **Observed:** the binary also exposes thread/queue operations. **Unverified:** queue acknowledgement, eventual processing, and race behavior through the originating interactive session. [App-server: quick start](https://learn.chatgpt.com/docs/app-server#quick-start); installed schema. | **Unverified in the desktop:** these are protocol capabilities, not proof that an external client can deliver to the particular app conversation. Same sources. |
| Interactive presence | **Documented:** loaded threads can remain after clients unsubscribe. **Observed:** ThreadStatus distinguishes notLoaded, idle, systemError, and active, without identifying a live human client in the inspected schema. **Unverified:** reliable originating-client ownership evidence. [App-server: thread/unsubscribe](https://learn.chatgpt.com/docs/app-server); installed Thread schema. | **Unverified:** no inspected contract establishes which app window or client owns a thread, or that a window closing immediately ends the thread. Process existence alone cannot answer this. Same sources. |
| Listener readiness | **Unverified for both interfaces:** neither idle status nor a successful historical hook establishes a presently connected Lucid listener. The inspected thread, loaded-list, queue, and lifecycle surfaces do not document a Lucid-specific acknowledgement or lease. This is a bounded finding about those sources, not proof that no additional integration exists. | Same limitation. |
| Transcript and artifact output | **Documented:** app-server subscriptions emit item/turn events and assistant deltas. Hook transcript paths may be null, and their transcript format is not stable. **Unverified:** replay/deduplication into Lucid and artifact publication linked to that native identity. [App-server: events](https://learn.chatgpt.com/docs/app-server); [Hooks: common input fields](https://learn.chatgpt.com/docs/hooks#common-input-fields). | **Unverified transport access:** event support is documented, but observing the desktop's existing thread was not tested. Same sources. |
| Headless resume | **Documented:** `codex exec resume` accepts an existing session ID; app-server supports thread/resume. **Unverified:** a captured CLI identity can be resumed through the installed HCN after verified client exit under this integration's configuration. [Developer commands: exec](https://learn.chatgpt.com/docs/developer-commands); [App-server: thread/resume](https://learn.chatgpt.com/docs/app-server). | **Unverified:** matching an ID does not prove the desktop and headless process share the relevant store and configuration. No app-to-headless round trip was performed. Same sources. |
| Installation and reload | **Documented:** hooks can come from config layers or plugins; unmanaged hooks require trust. **Unverified:** applying a new Lucid integration to this already-running session without reload/reconnect. [Hooks: discovery and trust](https://learn.chatgpt.com/docs/hooks). | **Unverified:** live desktop installation/reload and transport permissions were not exercised. Same sources. |

## Lifecycle cautions

- **Documented:** SessionEnd can follow explicit termination or an idle loaded thread losing all clients for 30 minutes. Switching away or unsubscribing does not immediately end it. A SessionEnd-based detector cannot promise immediate detection of a closed app view. [Hooks: SessionEnd](https://learn.chatgpt.com/docs/hooks#sessionend), retrieved 2026-09-11.
- **Documented:** subagent hooks use the parent session ID. An integration must distinguish the originating main conversation when interpreting hook events. [Hooks: common input fields](https://learn.chatgpt.com/docs/hooks#common-input-fields), same retrieval.
- **Observed:** the generated Thread schema says source/originator describe creation origin, not current client ownership. Runtime environment fields likewise do not establish client connection status. Installed experimental schema, ThreadReadResponse.json, Thread definitions, CLI 0.154.0.

These are evidence constraints for the later ownership decision. They do not change the user's requirement: an open but non-listening interactive session keeps feedback queued; confirmed exit permits same-session headless resume.

## Reproduction and source standing

Read-only commands run: `codex --version`, `codex queue --help`, `codex agents --help`, `codex app-server --help`, `codex app-server proxy --help`, and `codex app-server daemon --help`.

Offline schema command run: `codex app-server generate-json-schema --experimental --out artifacts/evidence/interactive-artifact-wayfinder/codex-schema`. Inspected ClientRequest, ThreadQueueAddParams, ThreadReadResponse, ThreadStatus, loaded-list and subscription definitions. The generated request union includes thread/queue/add, list, update, delete, reorder, and start. The public app-server page searched did not describe these queue operations. That difference is reported as version skew, not a promise of undocumented delivery behavior.

The evidence directory is local ignored run output. No daemon was started or stopped. No queue message was submitted. No private transcript or credential was read. Public protocol documentation was fetched through the official OpenAI documentation tool on 2026-09-11. The CLI version was observed; the desktop version and live desktop transport were not established.

## What remains for the decision and later validation

The connection decision must name the supported mechanism for each interface and how it obtains native ID, working folder, and originating-client evidence. A controlled live acceptance test must separately prove CLI and desktop delivery while idle/busy, listener loss while the client remains open, confirmed client exit, and native-history recall through HCN. This research does not establish those end-to-end claims. Unsupported or inaccessible interfaces require an explicit decision; they must not silently create a fresh session.

## Native protocol follow-up, 2026-09-11

Producer: the parent Codex session. No Anthropic model was invoked. These tests use synthetic conversations and an isolated server; no existing desktop conversation was read or messaged.

**Observed:** the installed desktop is ChatGPT 26.901.51231 and bundles codex-cli 0.153.4 at /Applications/ChatGPT.app/Contents/Resources/codex. The separate terminal CLI is 0.154.0. Version sources: application Info.plist and each executable's --version. Schema generation was repeated with the bundled binary. It exposes thread queue, resume, loaded-list and unsubscribe operations too. The earlier CLI-only inspection was therefore insufficient to establish desktop behavior, although these particular operations exist in both builds.

**Observed, bounded inspection:** the running desktop app's Codex child had anonymous socket pairs in lsof's Unix-socket listing, with no named control socket shown. This does not prove the app has no other integration, but it does not supply an external endpoint that Lucid can use. No attempt was made to seize its stdin, replace its transport, or attach to a user's thread.

An isolated instance of the desktop's bundled server was launched over a temporary loopback WebSocket endpoint. A local HTTP stub supplied the model catalogue for a custom probe provider. All provider requests stayed on loopback; no external inference was performed. Clients used the documented initialization and generated request schema. [Official app-server protocol and transport documentation](https://learn.chatgpt.com/docs/app-server#protocol), retrieved 2026-09-11, describes WebSocket transport as experimental and unsupported for production workloads. A successful probe is not an upstream production-support guarantee.

| Probe | Observed result | What it establishes |
| --- | --- | --- |
| Ephemeral thread | Queue operations refused; resume from a second client reported no rollout. | Ephemeral-thread support cannot stand in for the durable workflow. |
| Durable synthetic thread | Returned a native ID, matching working folder and idle status. | Registration metadata can be obtained from an owned app-server operation. |
| Resume before first durable activity | Second client initially received no-rollout-found. | New thread creation and availability of stored history have a timing boundary. Do not infer resumability from the initial ID alone. |
| Submit from a second client to that exact ID | Queue addition succeeded and the owning client received a queue-change notification. A turn started automatically. | Queue addition is an execution-capable action. A successful add is not merely passive storage or a listener-health probe. |
| Queue deletion after consumption | Returned success while the queue had already drained and a turn had started. | Delete success does not establish withdrawal of an input already dispatched. |
| Reconnect after durable activity | Another client resumed the same native ID successfully. | Reconnect works inside this shared server instance. It does not establish access to the running desktop app's server. |
| Unsubscribe every thread client | An independent inspection client still found the thread loaded. | Loaded-thread state does not prove that an interactive client remains subscribed. |

Local ignored receipts: artifacts/evidence/interactive-artifact-wayfinder/codex-native-probe.mjs and codex-native-probe.json; the ephemeral negative control is codex-native-ephemeral-probe.json. Generated schema: codex-desktop-schema/. The probe uses a synthetic provider and ends its own server and clients. No model answer or busy-turn delivery was claimed. Initial attempts using Unix framing timed out; the final observations above use the documented direct WebSocket framing.

**Still unverified:** supported external transport discovery for an already-running desktop conversation; per-thread originating-client ownership; an authenticated Lucid-listener acknowledgement; busy delivery and native-history recall through a real model. The connection contract must keep these distinct from the working shared-server primitive. It must not promise that codex queue can reach every desktop conversation just because the IDs have the same format.
