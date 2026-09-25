import { describe, expect, it } from 'vitest';
import { generationPrompt } from '../src/main/generation-prompt';
import type { Brief } from '../src/shared/types';

const brief: Brief = { topic:'', focus:'', prompt:'', notes:'', language:'zh', purpose:'paper', aspectRatio:'auto', widthMm:180, fullVector:true };
describe('direct generation without AI prompt preparation', () => {
  it('includes a paragraph and hand-written style without requiring a prompt', () => {
    const result=generationPrompt({...brief,topic:'观测状态经过神经网络定义的连续动力学积分，得到预测状态。',stylePrompt:'蓝绿色，横向布局'});
    expect(result).toContain('连续动力学积分');expect(result).toContain('蓝绿色，横向布局');expect(result).toContain('Chinese');
  });
  it('does not discard updated content when an older drawing prompt exists', () => {
    const result=generationPrompt({...brief,topic:'更新后的核心方法：物理约束神经 ODE',prompt:'保留四个模块和左到右布局'});
    expect(result).toContain('物理约束神经 ODE');expect(result).toContain('四个模块');
  });
  it('accepts a complete manual prompt and rejects style alone', () => {
    expect(generationPrompt({...brief,prompt:'Draw two connected blocks',language:'en'})).toContain('Draw two connected blocks');
    expect(()=>generationPrompt({...brief,stylePrompt:'蓝色'})).toThrow('请填写绘图内容');
  });
});
