# `@yourcrm/notifications`

Notification contracts + queue helper. Delivery channels (websocket, email,
push) are implemented by worker/API agents against the `notifications`
table; domain code only calls `queueNotification()`.
