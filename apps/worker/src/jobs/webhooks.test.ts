import { afterEach, describe, expect, test } from "bun:test"
import {
  registerWebhookSender,
  resetWebhookSender,
  runWebhookDeliveryJob,
  WEBHOOK_DELIVERY_JOB_NAME,
  webhookDeliveryJobId,
  webhookDeliveryJobPayloadSchema,
  WebhookSenderNotBoundError,
  type WebhookDeliveryJobPayload,
} from "./webhooks"
import { JobHandlers } from "../worker"

const payload: WebhookDeliveryJobPayload = {
  workspaceId: "ws_1",
  subscriptionId: "sub_1",
  deliveryId: "dlv_1",
  eventId: "evt_1",
  eventName: "person.created",
  attempt: 1,
}

afterEach(() => {
  resetWebhookSender()
})

describe("worker/webhook-delivery", () => {
  test("the handler is registered under the queue seam's job name", () => {
    expect(Object.keys(JobHandlers)).toContain(WEBHOOK_DELIVERY_JOB_NAME)
    expect(WEBHOOK_DELIVERY_JOB_NAME).toBe("webhook.deliver")
  })

  test("the payload is validated at run time, not just at enqueue", async () => {
    expect(webhookDeliveryJobPayloadSchema.parse(payload).deliveryId).toBe("dlv_1")
    await expect(runWebhookDeliveryJob({ ...payload, deliveryId: "" })).rejects.toThrow()
    await expect(runWebhookDeliveryJob({ ...payload, attempt: 0 })).rejects.toThrow()
    await expect(runWebhookDeliveryJob({ nope: true })).rejects.toThrow()
  })

  test("an unbound sender fails loudly instead of dropping the delivery", async () => {
    await expect(runWebhookDeliveryJob(payload)).rejects.toThrow(WebhookSenderNotBoundError)
  })

  test("a bound sender receives the validated payload", async () => {
    const seen: WebhookDeliveryJobPayload[] = []
    registerWebhookSender(async (input) => {
      seen.push(input)
      return {
        deliveryId: input.deliveryId,
        status: "succeeded",
        attempt: input.attempt,
        statusCode: 200,
        retryInMs: null,
        reason: null,
      }
    })
    const result = await runWebhookDeliveryJob(payload)
    expect(result.status).toBe("succeeded")
    expect(seen[0]?.eventId).toBe("evt_1")
  })

  test("IDEMPOTENCY: a retried job re-delegates, and the sender skips it", async () => {
    // `executeDelivery` claims the row with a conditional UPDATE, so the
    // second run of the same job makes no HTTP request at all.
    let delivered = 0
    registerWebhookSender(async (input) => {
      const settled = delivered > 0
      if (!settled) delivered += 1
      return {
        deliveryId: input.deliveryId,
        status: settled ? "skipped" : "succeeded",
        attempt: input.attempt,
        statusCode: settled ? null : 200,
        retryInMs: null,
        reason: settled ? "delivery is already settled or in flight" : null,
      }
    })
    expect((await runWebhookDeliveryJob(payload)).status).toBe("succeeded")
    expect((await runWebhookDeliveryJob(payload)).status).toBe("skipped")
    expect(delivered).toBe(1)
  })

  test("the job id dedupes a redelivery but never a scheduled retry", () => {
    expect(webhookDeliveryJobId({ deliveryId: "dlv_1", attempt: 1 })).toBe(
      "webhook.deliver:dlv_1:1",
    )
    // A retry is a NEW job; sharing the id with the failed attempt would
    // make BullMQ drop it as a duplicate.
    expect(webhookDeliveryJobId({ deliveryId: "dlv_1", attempt: 2 })).not.toBe(
      webhookDeliveryJobId({ deliveryId: "dlv_1", attempt: 1 }),
    )
  })
})
