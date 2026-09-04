对。**如果你说的“在 latent space 里加一个 loop”是指：模型不马上把 hidden state 解码成下一个 token，而是让 hidden state 在内部被反复更新若干次，那么 looped Transformer / recurrent-depth Transformer 基本就是这一类技术。**

不过从架构上说，有一个细节值得分清：

> **loop 不是加在“latent space”这个空间本身上的，而是加在 Transformer 的计算路径上。被循环处理的对象，是 latent space 里的 hidden state。**

这两种说法听起来接近，但理解清楚以后，你前面问的“增加深度到底改变了函数的什么”也会顺下来。

### 普通 Transformer 是一路向前的函数复合

假设输入 token 经过 embedding 后得到

$$H_0$$

普通 Transformer 有很多不同参数的层：

$$H_1=F_1(H_0)$$

$$H_2=F_2(H_1)$$

$$\cdots$$

$$H_L=F_L(H_{L-1})$$

最后：

$$y=C(H_L)$$

所以整个模型可以看成：

$$f(x)=C\circ F_L\circ F_{L-1}\circ\cdots\circ F_1\circ P(x)$$

这里 $H_0,H_1,\ldots,H_L$ 全部都是 **latent representations / hidden states**。换句话说，普通 Transformer 本来就一直在 latent space 中计算。

它的问题是，通常第 1 层有自己的参数，第 2 层又有另一套参数，一直堆到第 $L$ 层。计算深度和参数数量往往一起增长。

---

### Looped Transformer 做的事情是把其中一个函数重复用

最简单的版本可以写成：

$$H_1=R(H_0)$$

$$H_2=R(H_1)$$

$$H_3=R(H_2)$$

$$\cdots$$

$$H_r=R(H_{r-1})$$

注意这里始终是同一个 $R$。

因此：

$$f_r(x)=C\circ R^r\circ P(x)$$

其中

$$R^r =
\underbrace{R\circ R\circ R\circ\cdots\circ R}_{r\text{ 次}}$$

这就是所谓 **recurrent depth** 或 **looped Transformer**。

所以画成图就是：

```
tokens
   ↓
embedding / prelude
   ↓
  H₀
   ↓
┌─────────────┐
│ Transformer │
│   block R   │
└──────┬──────┘
       ↓
      H₁
       ↑
       │
       └──── loop
```

更准确一点：

```
H₀ → R → H₁ → R → H₂ → R → H₃ → ... → Hᵣ
       ↑        ↑        ↑
       └── same parameters ──┘
```

所有这些 $H_i$ 都是连续的高维 latent state。

2018 年的 **Universal Transformer** 已经非常明确地用了这个思想。论文甚至专门强调，它的 recurrence 不是沿着 token 位置进行，而是沿着 representation 的 successive revisions，也就是 **“over depth”**。每一次 recurrence 都重新修改整段序列的 hidden representations。[arXiv](https://arxiv.org/abs/1807.03819)

后来所谓的 looped Transformer，又把这种思想系统地用于迭代算法学习。例如 2023 年的 *Looped Transformers as Programmable Computers* 直接研究将固定 Transformer 放入循环，让同一套网络反复执行计算。[Proceedings of Machine Learning Research](https://proceedings.mlr.press/v202/giannou23a.html?utm_source=chatgpt.com) 2024 年 ICLR 的 *Looped Transformers are Better at Learning Learning Algorithms* 则发现，这种结构特别适合模拟本来就具有迭代形式的算法。[ICLR Proceedings](https://proceedings.iclr.cc/paper_files/paper/2024/hash/b8402301e7f06bdc97a31bfaa653dc32-Abstract-Conference.html?utm_source=chatgpt.com)

---

## 为什么最近又经常把它叫做“latent-space reasoning”？

因为 2025 年 Geiping 等人的 **Recurrent Depth** 工作，把这个架构直接用于语言模型的 test-time reasoning。

他们把模型分成：

$$P \rightarrow R \rightarrow C$$

也就是：

**Prelude → Recurrent Block → Coda**

Prelude 先把 token 处理成 latent representation：

$$e=P(x)$$

然后 recurrent block 在内部反复更新一个 latent state：

$$s_{k+1}=R(s_k,e)$$

最后才让 Coda 把最终 latent state 解码为 token：

$$p(y|x)=C(s_r)$$

论文就是这样描述的：Prelude 把输入映射进 latent space，shared recurrent block 在这个空间里反复修改 state，最后 Coda 将最终 state 转回 vocabulary distribution。[arXiv+1](https://arxiv.org/abs/2502.05171)

因此在这种架构里，模型可以：

```
问题
 ↓
latent state₀
 ↓
思考一次
 ↓
latent state₁
 ↓
思考一次
 ↓
latent state₂
 ↓
思考一次
 ↓
latent state₃
 ↓
输出 token
```

而传统 Chain-of-Thought 是：

```
问题
 ↓
"First, we need..."
 ↓
token
 ↓
"Then..."
 ↓
token
 ↓
"Therefore..."
 ↓
token
 ↓
答案
```

Recurrent-depth 模型可以在**一个 token 都没有输出的情况下增加内部计算量**。这正是这篇 NeurIPS 2025 工作所谓的 “reasoning in latent space”。[NeurIPS Proceedings+1](https://proceedings.nips.cc/paper_files/paper/2025/hash/3b01972cf31e6fa0fe29e4b8b5c2a0a1-Abstract-Conference.html?utm_source=chatgpt.com)

它们的 3.5B 模型就是一个很直观的例子。模型结构是

$$(l_P,l_R,l_C)=(2,4,2)$$

从物理参数来看只有 8 个 Transformer layers 的结构，其中中间 4 层作为 recurrent block。如果把中间的 4 层循环 32 次，有效计算深度就变成：

$$2+4\times32+2=132$$

也就是说，**参数还是那套参数，函数却被复合了更多次。** [arXiv](https://arxiv.org/abs/2502.05171)

这正好对应你之前从“LLM 是一个函数”角度产生的疑问。

虽然 $R$ 没有变，

$$R(x)$$

和

$$R(R(x))$$

一般当然不是同一个函数。

再多一次：

$$R(R(R(x)))$$

又是另一个函数。

因此 loop 数 $r$ 实际上定义了一族函数：

$$f_1(x),f_2(x),f_3(x),\ldots$$

其中

$$f_r(x)=C(R^r(P(x)))$$

所以**增加 recurrent depth，并没有增加新的参数，却改变了输入到输出之间执行的函数。**

---

## 这里还容易和另一种“latent loop”混淆

还有一条研究路线，比如 Meta 的 **Coconut / Chain of Continuous Thought**。

Coconut 做的是：

$$\text{LLM}(x)\rightarrow h_1$$

然后不把 $h_1$ 变成一个词，而是直接把：

$$h_1$$

作为下一步的 input embedding，再送进 LLM：

$$h_1\rightarrow \text{LLM}\rightarrow h_2$$

再：

$$h_2\rightarrow\text{LLM}\rightarrow h_3$$

也就是：

```
normal CoT

hidden → logits → token → embedding → hidden
                  ↑
              离散语言瓶颈


Coconut

hidden ─────────────────→ next input
   ↑                        ↓
   └──────────────── hidden
```

Coconut 的论文明确说，它把最后一个 hidden state 当作 “continuous thought”，绕过 vocabulary decoding，直接作为下一步输入 embedding。[arXiv](https://arxiv.org/abs/2412.06769?utm_source=chatgpt.com)

这个也可以非常自然地称为“在 latent space 里面 loop”。

但它和 recurrent-depth Transformer 的 loop **位置不同**。

方法 | 循环什么 | 循环发生在哪里
--- | --- | ---
Standard Transformer | 没有权重共享的 depth recurrence | $F_1\to F_2\to\cdots F_L$
Looped / recurrent-depth Transformer | hidden state | 同一个 Transformer block 重复执行
Coconut | last hidden state | hidden state 被作为下一“latent step”的输入
Explicit CoT | token | 输出文字，再把文字作为新输入

所以如果有人只说：

> “在 latent space 里加一个 loop”

其实可能是在说 **Coconut 型 latent recurrence**，也可能是在说 **recurrent-depth / looped Transformer**。

两者在概念上有共同目标：**不要每完成一点计算就必须压缩成一个离散 token，让连续 hidden representation 可以继续计算。**

但具体架构不是同一回事。

有意思的是，到 2026 年这两条路线已经开始融合。Microsoft Research 的 LOTUS 工作直接称 **“Looped, or recurrent-depth, Transformers”**，然后用这种架构做 latent Chain-of-Thought，让多个 latent representations 经过多轮循环更新。[Microsoft](https://www.microsoft.com/en-us/research/publication/bridging-the-gap-between-latent-and-explicit-reasoning-with-looped-transformers/?utm_source=chatgpt.com)

---

### 所以你可以这样记

**Looped Transformer：**

$$\boxed{s_{t+1}=R(s_t)}$$

同一个 Transformer computation block 不断修改 latent state。

**Coconut：**

$$\boxed{h_t\rightarrow\text{下一步的 input embedding}}$$

把一次完整 LLM forward 得到的 hidden state，作为下一 latent reasoning step 的输入。

**普通 CoT：**

$$\boxed{h_t\rightarrow token_t\rightarrow embedding(token_t)}$$

中间必须经过语言。

所以你最开始那句话，我会稍微改成：

> **Looped Transformer 是让 latent representation 在 depth 方向上经过同一个 Transformer block 多次迭代更新。**

这个表述基本就抓住它的数学结构了。

而且这里有一个很有意思的后续问题：**既然 $R^1,R^2,\ldots,R^{100}$ 是越来越深的函数复合，为什么同一个 $R$ 重复 100 次不会只是越来越趋向一个 fixed point，把信息“磨平”？** 这其实正好连接到你前面问的“深度为什么可能影响泛化”，也是 recurrent depth 现在最值得研究的问题之一。2026 年的研究已经开始专门研究这种 representation collapse、convergence 和有效计算深度的问题。[aclanthology.org](https://aclanthology.org/2026.acl-long.1809/?utm_source=chatgpt.com)