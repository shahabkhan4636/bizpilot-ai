"use client";

import { useActionState, useEffect, useState } from "react";
import { Copy, RefreshCw, Save, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { generateContentAction, saveDraftAction, approveAndSendAction, type AiState } from "@/lib/actions/ai";
import { AI_KINDS, AI_KIND_LABEL } from "@/lib/ai";

export function AiWorkspace({
  leads,
  aiConfigured,
  emailConfigured,
  usage,
  limit,
  defaultKind,
  defaultLead,
  businessName,
}: {
  leads: { id: string; name: string; email: string | null; company: string | null; notes: string | null }[];
  aiConfigured: boolean;
  emailConfigured: boolean;
  usage: number;
  limit: number;
  defaultKind: string;
  defaultLead: string;
  businessName: string;
}) {
  const [genState, generate, generating] = useActionState(generateContentAction, null as AiState);
  const [saveState, save, saving] = useActionState(saveDraftAction, null as AiState);
  const [sendState, send, sending] = useActionState(approveAndSendAction, null as AiState);

  const [leadId, setLeadId] = useState(defaultLead);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [to, setTo] = useState("");
  const [approved, setApproved] = useState(false);
  const [copied, setCopied] = useState(false);

  const lead = leads.find((l) => l.id === leadId);

  // Seed the editable panel whenever a fresh generation arrives.
  useEffect(() => {
    if (genState?.text) setBody(genState.text);
    if (genState?.kind && !subject) setSubject(genState.kind);
    if (genState?.messageId) {
      setApproved(false);
      setSendStateId(genState.messageId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genState?.messageId, genState?.text]);

  useEffect(() => {
    if (lead?.email && !to) setTo(lead.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const [messageId, setSendStateId] = useState<string | undefined>(undefined);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <form id="ai-generate-form" action={generate} className="space-y-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Generate content</h2>
            <span className="text-xs text-[hsl(var(--fg-muted))]">{usage} / {limit} this month</span>
          </div>

          {!aiConfigured ? (
            <Alert tone="warning" title="No AI provider configured">
              AI_API_KEY is not set on this deployment, so generation will report that state instead of inventing text.
              You can still write and save a message manually below.
            </Alert>
          ) : null}
          {genState?.error ? <Alert tone="danger" title="Generation problem">{genState.error}</Alert> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="kind">Content type</Label>
              <Select id="kind" name="kind" defaultValue={defaultKind}>
                {AI_KINDS.map((k) => <option key={k} value={k}>{AI_KIND_LABEL[k]}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead_id">Related lead (optional)</Label>
              <Select id="lead_id" name="lead_id" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">None</option>
                {leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tone">Tone</Label>
              <Select id="tone" name="tone" defaultValue="professional">
                {["professional", "friendly", "direct", "warm", "formal", "concise"].map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="language">Language</Label>
              <Select id="language" name="language" defaultValue="English">
                {["English", "Urdu", "Arabic", "Spanish", "French", "German", "Hindi"].map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="objective">Objective</Label>
            <Input id="objective" name="objective" placeholder="Book a 20-minute discovery call" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="services">Services to mention</Label>
            <Input id="services" name="services" placeholder="Shopify store builds, monthly SEO retainers" defaultValue="" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pricing">Pricing to quote (optional)</Label>
            <Input id="pricing" name="pricing" placeholder="Starts at $1,200 for the build" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="customer_name">Customer name</Label>
              <Input id="customer_name" name="customer_name" defaultValue={lead?.name ?? ""} key={`n-${leadId}`} placeholder="Sara Ahmed" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customer_company">Customer company</Label>
              <Input id="customer_company" name="customer_company" defaultValue={lead?.company ?? ""} key={`c-${leadId}`} placeholder="Vertex Interiors" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="customer_notes">Context about the customer</Label>
            <Textarea id="customer_notes" name="customer_notes" rows={2} className="min-h-[64px]" defaultValue={lead?.notes ?? ""} key={`o-${leadId}`} placeholder="Asked about a 6-week timeline and a payment plan." />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="extra">Anything else</Label>
            <Textarea id="extra" name="extra" rows={2} className="min-h-[64px]" placeholder="Mention that we can start on the 12th." />
          </div>

          <Button type="submit" disabled={generating}>
            <Sparkles className="h-4 w-4" /> {generating ? "Generating…" : "Generate draft"}
          </Button>
          <p className="text-xs text-[hsl(var(--fg-muted))]">
            Business name used in the prompt: <strong>{businessName}</strong>. The model is told never to invent facts,
            prices or testimonials.
          </p>
        </form>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Draft</h2>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="ghost" onClick={copy} disabled={!body}>
                <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setBody(""); setSubject(""); }} disabled={!body}>
                Clear
              </Button>
            </div>
          </div>

          {genState?.method && genState.method !== "ai" ? (
            <div className="mb-3">
              <Alert tone="warning" title="Not generated by AI">
                Provider state: <code>{genState.method}</code>. The text in the box is an explanation, not content.
              </Alert>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line" />
            <Label htmlFor="body">Body — edit freely</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className="min-h-[280px] font-mono text-xs"
              placeholder="Generate a draft, or type your own message here."
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <form action={save}>
              <input type="hidden" name="message_id" value={messageId ?? ""} />
              <input type="hidden" name="subject" value={subject} />
              <input type="hidden" name="body" value={body} />
              <Button type="submit" size="sm" variant="outline" disabled={saving || !messageId || !body}>
                <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save draft"}
              </Button>
            </form>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={generating}
              onClick={() => {
                (document.getElementById("ai-generate-form") as HTMLFormElement | null)?.requestSubmit();
              }}
            >
              <RefreshCw className="h-4 w-4" /> Regenerate
            </Button>
          </div>
          {saveState?.notice ? <p className="mt-2 text-xs text-emerald-600">{saveState.notice}</p> : null}
          {saveState?.error ? <p className="mt-2 text-xs text-red-600">{saveState.error}</p> : null}
        </div>

        <form action={send} className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
          <h2 className="font-semibold">Approval required before sending</h2>
          <p className="text-xs text-[hsl(var(--fg-muted))]">
            Nothing leaves BizPilot without this step. If email delivery is not configured, the message is stored as
            approved-but-unsent and you will be told — it is never marked as sent.
          </p>
          {!emailConfigured ? (
            <Alert tone="warning" title="Email provider missing">
              RESEND_API_KEY is not set, so this will save the approval without sending.
            </Alert>
          ) : null}
          {sendState?.error ? <Alert tone="danger" title="Not sent">{sendState.error}</Alert> : null}
          {sendState?.notice ? <Alert tone="success">{sendState.notice}</Alert> : null}

          <input type="hidden" name="message_id" value={messageId ?? ""} />
          <input type="hidden" name="subject" value={subject} />
          <input type="hidden" name="body" value={body} />
          <div className="space-y-1.5">
            <Label htmlFor="to">Send to</Label>
            <Input id="to" name="to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@example.com" required />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="approved"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              value="on"
              className="mt-0.5 h-4 w-4 rounded border-[hsl(var(--border))]"
            />
            <span>I have read this message and approve sending it to the recipient above.</span>
          </label>
          <Button type="submit" size="sm" disabled={sending || !approved || !messageId || !body || !to}>
            <Send className="h-4 w-4" /> {sending ? "Sending…" : "Approve & send"}
          </Button>
          {!messageId ? <p className="text-xs text-[hsl(var(--fg-muted))]">Generate or save a draft first to get a message id.</p> : null}
        </form>
      </div>
    </div>
  );
}
