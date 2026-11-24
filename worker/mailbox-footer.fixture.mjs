// Captured from installed Orca 1.4.272 public formatters with synthetic inputs only.
export const minimalText =
  'msg_rest_minimal_01 [status] from=term_a\n[subject]\n  Synthetic acceptance\n[body]\n  Synthetic content\n[Reply: orca orchestration reply --id msg_rest_minimal_01 --from term_b --body "..."]\n\nmsg_followup_minimal_02 [worker_done] from=term_a\n[subject]\n  Synthetic acceptance\n[body]\n  Synthetic content\n[Its follow-up ctx_123 is running; to message it: orca orchestration send --to dispatch:ctx_123 --subject "..." --body "..."]\n\nmsg_item_minimal_03 [status] from=term_a\n[subject]\n  Synthetic acceptance\n[body]\n  Synthetic content\n[Reply: orca orchestration reply --id msg_item_minimal_03 --from term_b --body "..."]'
export const minimalIds = ['msg_rest_minimal_01', 'msg_followup_minimal_02', 'msg_item_minimal_03']
export const footerCases = [
  {
    name: 'reply',
    lines: ['[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]']
  },
  {
    name: 'information',
    lines: ['[For your information: there is nothing to answer]']
  },
  {
    name: 'send-inactive',
    lines: [
      '[To give this worker more work: orca orchestration send --to dispatch:ctx_123 --subject "..." --body "..."]'
    ]
  },
  {
    name: 'send-active',
    lines: [
      '[Its follow-up ctx_123 is running; to message it: orca orchestration send --to dispatch:ctx_123 --subject "..." --body "..."]'
    ]
  },
  {
    name: 'worker-start',
    lines: ['[To start a new worker: orca orchestration worker-start --spec "..."]']
  },
  {
    name: 'worker-on-0',
    lines: [
      '[To start more work on fixture: orca orchestration worker-start --on fixture --spec "..."]'
    ]
  },
  {
    name: 'worker-on-1',
    lines: [
      '[To start more work on fixture server: orca orchestration worker-start --on "fixture server" --spec "..."]'
    ]
  },
  {
    name: 'worker-on-2',
    lines: [
      '[To start more work on 中文 "机" \\ $cost `tick`: orca orchestration worker-start --on "中文 \\"机\\" \\\\ \\$cost \\`tick\\`" --spec "..."]'
    ]
  },
  {
    name: 'worker-on-3',
    lines: [
      '[To start more work on name: orca orchestration worker-start --on x: orca orchestration worker-start --on "name: orca orchestration worker-start --on x" --spec "..."]'
    ]
  },
  {
    name: 'mail-sender',
    lines: [
      '[To answer its sender: orca orchestration send --to bot:fixture --subject "..." --body "..."]'
    ]
  },
  {
    name: 'mail-sender-chat',
    lines: [
      '[To answer its sender: orca orchestration send --to bot:fixture --chat 7 --type question --subject "..." --body "..."]'
    ]
  },
  {
    name: 'mail-sender-quoted',
    lines: [
      '[To answer its sender: orca orchestration send --to "bot:中文 \\"名\\" \\\\ \\$cost \\`tick\\`" --chat chat_fixture --type question --subject "..." --body "..."]'
    ]
  },
  {
    name: 'item-planned-0',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-planned-0-information',
    lines: [
      '[For your information: there is nothing to answer]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-planned-0-worker-on-2',
    lines: [
      '[To start more work on 中文 "机" \\ $cost `tick`: orca orchestration worker-start --on "中文 \\"机\\" \\\\ \\$cost \\`tick\\`" --spec "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-planned-1',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-planned-2',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). Done means: Ready criterion. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-planned-3',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). Done means: Ready. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-planned-4',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). Done means: Ready? [item] "quote". If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-planned-5',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Planned). Done means: Ready! If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-working-0',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-working-0-send-inactive',
    lines: [
      '[To give this worker more work: orca orchestration send --to dispatch:ctx_123 --subject "..." --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-working-0-worker-on-3',
    lines: [
      '[To start more work on name: orca orchestration worker-start --on x: orca orchestration worker-start --on "name: orca orchestration worker-start --on x" --spec "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-working-1',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-working-2',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). Done means: Ready criterion. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-working-3',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). Done means: Ready. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-working-4',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). Done means: Ready? [item] "quote". If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-working-5',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (In progress). Done means: Ready! If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-waiting-0',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-waiting-0-send-active',
    lines: [
      '[Its follow-up ctx_123 is running; to message it: orca orchestration send --to dispatch:ctx_123 --subject "..." --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-waiting-0-mail-sender',
    lines: [
      '[To answer its sender: orca orchestration send --to bot:fixture --subject "..." --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-waiting-1',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-waiting-2',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). Done means: Ready criterion. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-waiting-3',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). Done means: Ready. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-waiting-4',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). Done means: Ready? [item] "quote". If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-waiting-5',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Waiting). Done means: Ready! If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-needs_you-0',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-needs_you-0-worker-start',
    lines: [
      '[To start a new worker: orca orchestration worker-start --spec "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-needs_you-0-mail-sender-chat',
    lines: [
      '[To answer its sender: orca orchestration send --to bot:fixture --chat 7 --type question --subject "..." --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-needs_you-1',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-needs_you-2',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). Done means: Ready criterion. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-needs_you-3',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). Done means: Ready. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-needs_you-4',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). Done means: Ready? [item] "quote". If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-needs_you-5',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Needs you). Done means: Ready! If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-done-0',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-done-0-worker-on-0',
    lines: [
      '[To start more work on fixture: orca orchestration worker-start --on fixture --spec "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-done-0-mail-sender-quoted',
    lines: [
      '[To answer its sender: orca orchestration send --to "bot:中文 \\"名\\" \\\\ \\$cost \\`tick\\`" --chat chat_fixture --type question --subject "..." --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-done-1',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-done-2',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). Done means: Ready criterion. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-done-3',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). Done means: Ready. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-done-4',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). Done means: Ready? [item] "quote". If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-done-5',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Done). Done means: Ready! If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-canceled-0',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'combined-canceled-0-worker-on-1',
    lines: [
      '[To start more work on fixture server: orca orchestration worker-start --on "fixture server" --spec "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-canceled-1',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-canceled-2',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). Done means: Ready criterion. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-canceled-3',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). Done means: Ready. If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-canceled-4',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). Done means: Ready? [item] "quote". If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  },
  {
    name: 'item-canceled-5',
    lines: [
      '[Reply: orca orchestration reply --id msg_fixture_footer --from term_b --body "..."]',
      '[This worker was started for item 19, "Synthetic "title" [brackets] msg_fake_item [status] from=term_c" (Canceled). Done means: Ready! If this result changes the item, update it with orca bot item <cancel|comment|done|set> 19.]'
    ]
  }
]
