import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { DriverChoices } from "./driver-menus.js";
import { SettingsForm, type SettingsValues } from "./settings-form.js";
import { Button } from "./ui/button.js";

export const PENDING_CREATION = "lucid.pending-creation.v1";
export function NewConversation(props: {
  readonly request: (path: string, body?: string) => Promise<Response>;
}) {
  const [pending, setPending] = useState<string | null>(() =>
    sessionStorage.getItem(PENDING_CREATION),
  );
  const defaults = useQuery({
    queryKey: ["creation-defaults"],
    queryFn: async () => {
      const response = await props.request("defaults");
      const data = await response.json();
      if (!response.ok) throw new Error(data.reason ?? "Cannot load defaults");
      return data as {
        selected: SettingsValues | null;
        choices: DriverChoices;
        restartRequired: boolean;
        error: string | null;
        folderPickerAvailable: boolean;
      };
    },
  });
  const create = useMutation({
    mutationFn: async (body: string) => {
      const response = await props.request("conversations", body);
      const data = await response.json();
      if (!response.ok) {
        if (response.status < 500) {
          sessionStorage.removeItem(PENDING_CREATION);
          setPending(null);
        } else setPending(body);
        throw new Error(data.reason ?? "Cannot create conversation");
      }
      sessionStorage.removeItem(PENDING_CREATION);
      window.location.assign(`/c/${encodeURIComponent(data.conversationId)}`);
    },
  });
  const send = async (body: string): Promise<string | null> => {
    sessionStorage.setItem(PENDING_CREATION, body);
    try {
      await create.mutateAsync(body);
      return null;
    } catch (error) {
      if (sessionStorage.getItem(PENDING_CREATION)) setPending(body);
      return error instanceof Error ? error.message : "Response lost. Retry creation.";
    }
  };
  return (
    <section className="hub-create" aria-label="New conversation">
      <h2>New conversation</h2>
      {defaults.error ? (
        <p role="alert" className="settings-error">
          {defaults.error.message}
        </p>
      ) : null}
      {defaults.data?.error ? (
        <p role="alert" className="settings-error">
          {defaults.data.error} Choose a complete set of settings or correct the config.
        </p>
      ) : null}
      {defaults.data?.restartRequired ? (
        <p role="status">The record folder changed in config. Restart Lucid to use it.</p>
      ) : null}
      {pending ? (
        <>
          <p>
            Creation has not been confirmed. Check the saved request before creating another
            conversation.
          </p>
          <Button variant="outline" disabled={create.isPending} onClick={() => void send(pending)}>
            Retry creation
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              sessionStorage.removeItem(PENDING_CREATION);
              setPending(null);
              create.reset();
            }}
          >
            Discard saved request
          </Button>
          <p>A conversation may already exist. Discarding this request does not delete it.</p>
          {create.error ? (
            <p role="alert" className="settings-error">
              {create.error.message}
            </p>
          ) : null}
        </>
      ) : defaults.data ? (
        <SettingsForm
          initial={defaults.data.selected ?? { harness: "", model: "", effort: "", profile: "" }}
          choices={defaults.data.choices}
          workingDirectory=""
          onChooseFolder={
            defaults.data.folderPickerAvailable
              ? async () => {
                  const response = await props.request("folder-picker", "{}");
                  const result = await response.json();
                  if (!response.ok)
                    throw new Error(result.reason ?? "Cannot open the folder picker.");
                  if (result.status === "cancelled") return null;
                  if (result.status !== "selected" || typeof result.workingDirectory !== "string")
                    throw new Error("The folder selection was not confirmed. Try again.");
                  return result.workingDirectory;
                }
              : undefined
          }
          submitLabel="Create conversation"
          onSave={(settings, workingDirectory) =>
            send(JSON.stringify({ creationId: crypto.randomUUID(), workingDirectory, settings }))
          }
        />
      ) : defaults.isPending ? (
        <p>Loading defaults…</p>
      ) : (
        <Button onClick={() => void defaults.refetch()}>Reload defaults</Button>
      )}
      <p>Creating or opening a conversation starts no agent.</p>
    </section>
  );
}
