// 模型下拉的分组逻辑（纯函数，单独成文件是为了能直接跑单测）。
// 同一个模型名可能挂在好几家名下：各家转发的同名模型、官方接口与订阅通道并存，
// 光看模型名挑不出是哪家，选下去才发现走错了通道。所以按模型商分组：
// 组标题是模型商，组内是它家的模型；同一家名下有多条通道时，再给每条标上通道名。

export function groupModelChoices(choices) {
  const list = Array.isArray(choices) ? choices : [];
  // 无组的特殊项分两头：「跟随 / 不设」置顶，「已不在列表」的旧选择沉到最底。
  const plain = list.filter((choice) => !choice.group);
  const head = plain.filter((choice) => (choice.order ?? 0) <= 0);
  const tail = plain.filter((choice) => (choice.order ?? 0) > 0);

  const groups = [];
  for (const choice of list) {
    if (!choice.group) continue;
    let group = groups.find((item) => item.label === choice.group);
    if (!group) {
      group = { label: choice.group, items: [] };
      groups.push(group);
    }
    group.items.push(choice);
  }

  for (const group of groups) {
    // 组内只有一条通道时不必再标，组标题已经说清是哪家；有多条才标通道名。
    const providers = new Set(group.items.map((choice) => choice.provider));
    const showChannel = providers.size > 1;
    group.items = group.items.map((choice) => ({
      ...choice,
      channel: showChannel ? (choice.channel || choice.provider || '') : '',
    }));
  }

  return { head, groups, tail };
}
