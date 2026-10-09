// 第一次启动、数据为空时写入的默认账号矩阵。之后在页面「账号矩阵」里改。
// 账号只是频道（名称、平台、一句话大方向），人群、主角、风格写在系列里。
const series = (id, s) => ({ id, collections: {}, voice: null, length: '30–60 秒', active: true, ...s });

export const SEED_ACCOUNTS = {
  accA: {
    code: 'A', name: '暖', order: 0, color: 'amber', active: false, platforms: ['douyin'], brief: 'AI 怀旧和亲情',
    series: [series('sA1', {
      name: '回到那一年', summary: 'AI 怀旧和亲情短片，比如“AI 带你回到 1990 年的县城”、AI 修复老照片里的家',
      audience: '小镇中年，30–50 岁，三四线城市，重家庭', persona: '温和的旁白，像家里长辈在讲旧事',
      visual: '写实暖色调，胶片质感', emotions: ['感动', '怀旧'], structure: '一张老照片开场 → 慢慢“走进”那一年 → 落到一句家常话', topics: '老照片、老物件、年代记忆',
    })],
  },
  accB: {
    code: 'B', name: '打工动物', order: 1, color: 'blue', active: true, platforms: ['douyin', 'bilibili'], brief: '荒诞职场',
    series: [series('sB1', {
      name: '打工动物', summary: '固定的 AI 拟人动物角色，在公司上班的荒诞职场连载剧：被老板 PUA、开会、加班、逆袭',
      audience: '城市打工人，22–35 岁，一二线城市', persona: '几只拟人动物同事，台词短而毒舌',
      visual: '3D 卡通', emotions: ['代入', '好笑', '爽感'], structure: '一个职场梗开场 → 冲突升级 → 结尾反转', topics: '开会、加班、老板、同事',
    })],
  },
  accC: {
    code: 'C', name: '整活研究所', order: 2, color: 'violet', active: true, platforms: ['bilibili', 'douyin'], brief: 'AI 脑洞整活',
    series: [series('sC1', {
      name: '如果实验', summary: 'AI 脑洞实验：如果古人用上现代科技、AI 山海经杂交生物、动物奥运会',
      audience: '学生和 Z 世代，16–25 岁', persona: '玩梗的实验员，快人快语',
      visual: '快节奏，强反差，B 站版本更长、更多细节彩蛋', emotions: ['反差', '好笑', '好奇'], structure: '一个“如果”开场 → 连续反差画面 → 彩蛋收尾', topics: '历史、神话、动物、科技反差',
    })],
  },
  accD: {
    code: 'D', name: '治愈', order: 3, color: 'green', active: false, platforms: ['xhs', 'douyin'], brief: 'AI 治愈系',
    series: [series('sD1', {
      name: '萌宠小剧场', summary: 'AI 萌宠治愈动画和美学视觉，小红书主发图文和短视频',
      audience: '女性用户，宝妈和年轻女生', persona: '安静的小动物主角，没有台词或只有轻声旁白',
      visual: '柔和配色，梦核或吉卜力感画面，安静的配乐', emotions: ['治愈'], structure: '一个小场景 → 一点小意外 → 温柔结尾', topics: '萌宠日常、季节、小确幸',
    })],
  },
};
