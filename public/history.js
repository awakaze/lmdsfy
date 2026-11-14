// A reply version owns the follow-up branch created from that version.
window.ChatHistory = {
  snapshot(message) {
    const { variants, variantIndex, ...reply } = message;
    return structuredClone(reply);
  },
  prepareRegeneration(conversation, index) {
    const message = conversation.messages[index];
    if (!message || message.role !== 'assistant') throw new Error('找不到要重新生成的回答');
    const variants = structuredClone(message.variants || []);
    const selected = message.variantIndex || 0;
    variants[selected] = { message: this.snapshot(message), following: structuredClone(conversation.messages.slice(index + 1)) };
    return { index, prefix: structuredClone(conversation.messages.slice(0, index)), variants };
  },
  commitRegeneration(conversation, pending, reply) {
    const variants = [...pending.variants, { message: this.snapshot(reply), following: [] }];
    conversation.messages = [...pending.prefix, { ...reply, variants, variantIndex: variants.length - 1 }];
  },
  selectVersion(conversation, index, target) {
    const message = conversation.messages[index];
    if (!message?.variants || !message.variants[target]) return;
    const variants = structuredClone(message.variants);
    variants[message.variantIndex || 0] = { message: this.snapshot(message), following: structuredClone(conversation.messages.slice(index + 1)) };
    const selected = variants[target];
    conversation.messages = [...conversation.messages.slice(0, index), { ...selected.message, variants, variantIndex: target }, ...selected.following];
  },
};
