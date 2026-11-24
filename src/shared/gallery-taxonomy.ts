import type { PaperCitation, PaperFigure, StudyCategory, StudyDimension, StudyForm } from './types';

export const LOCAL_GALLERY = 'mkfigure://gallery/';
export const journalVenues: Record<string, [string, string]> = {
  tpwrs: ['TPWRS', 'IEEE Transactions on Power Systems'], tsg: ['TSG', 'IEEE Transactions on Smart Grid'],
  tste: ['TSTE', 'IEEE Transactions on Sustainable Energy'], tpwrd: ['TPWRD / TPD', 'IEEE Transactions on Power Delivery'],
  tec: ['TEC', 'IEEE Transactions on Energy Conversion'], tnnls: ['TNNLS', 'IEEE Transactions on Neural Networks and Learning Systems'],
  tcyb: ['TCYB', 'IEEE Transactions on Cybernetics'], tai: ['TAI', 'IEEE Transactions on Artificial Intelligence'],
  apenergy: ['Applied Energy', 'Applied Energy'], ees: ['EES', 'Energy & Environmental Science'], renene: ['Renewable Energy', 'Renewable Energy'],
  nature: ['Nature', 'Nature'], natenergy: ['Nature Energy', 'Nature Energy'], natcommun: ['Nature Communications', 'Nature Communications'],
  natelectron: ['Nature Electronics', 'Nature Electronics'], natmachintell: ['Nature Machine Intelligence', 'Nature Machine Intelligence'],
  natcomputsci: ['Nature Computational Science', 'Nature Computational Science'], natsustain: ['Nature Sustainability', 'Nature Sustainability'],
  commseng: ['Communications Engineering', 'Communications Engineering'],
};
export const studyCategories: Record<StudyCategory, [string, string]> = {
  result: ['算例结果图', 'Experimental results'], mechanism: ['机理解释图', 'Mechanism explanations'], algorithm: ['算法图', 'Algorithms'],
};
export const researchTopics: Record<string, [string, string]> = {
  powerflow: ['潮流与最优潮流', 'Power flow and OPF'], stability: ['暂态与小扰动稳定', 'Transient and small-signal stability'],
  frequency: ['调频与构网', 'Frequency regulation and grid-forming control'], voltage: ['电压调节', 'Voltage regulation'],
  dispatch: ['调度与机组组合', 'Dispatch and unit commitment'], market: ['电力市场与电价', 'Electricity markets and tariffs'],
  renewables: ['风电与光伏', 'Wind and solar generation'], storage: ['电池与储能', 'Batteries and energy storage'],
  forecast: ['时序与轨迹预测', 'Time series and trajectory forecasts'], resilience: ['供电恢复与可靠性', 'Restoration and reliability'],
  emissions: ['碳排放与脱碳', 'Carbon emissions and decarbonization'], charging: ['电动汽车充电', 'Electric vehicle charging'],
  control: ['控制与变流器', 'Controllers and converters'], graphlearning: ['图神经网络', 'Graph neural networks'],
};
export const dimensionNames: Record<StudyDimension | 'mixed', [string, string]> = {
  '2d': ['二维', '2D'], '3d': ['三维', '3D'], mixed: ['二维与三维混合', 'Mixed 2D and 3D'],
};
export const formNames: Record<StudyForm, [string, string]> = {
  curve: ['曲线图', 'Line plot'], bar: ['柱状图', 'Bar chart'], scatter: ['散点图', 'Scatter plot'],
  distribution: ['分布图', 'Distribution'], heatmap: ['热图', 'Heatmap'], field: ['空间场', 'Spatial field'],
  qualitative: ['定性对照', 'Qualitative comparison'], surface: ['三维曲面', '3D surface'],
  pointcloud: ['点云', 'Point cloud'], volume: ['体绘制', 'Volume rendering'], mesh: ['网格', 'Mesh'],
  map: ['地理地图', 'Geographic map'], contour: ['等值线', 'Contour plot'], timeseries: ['时序响应', 'Time series'],
  uncertainty: ['不确定性区间', 'Uncertainty interval'],
  histogram: ['直方图', 'Histogram'],
  density: ['密度图', 'Density plot'],
  boxplot: ['箱线图', 'Box plot'],
  violin: ['小提琴图', 'Violin plot'],
  ecdf: ['累积分布', 'Cumulative distribution'],
  parity: ['预测与实测对照', 'Predicted versus observed'],
  residual: ['残差图', 'Residual plot'],
  sensitivity: ['灵敏度分析', 'Sensitivity analysis'],
  spectrum: ['频谱与时频谱', 'Spectrum and spectrogram'],
  trajectory: ['相轨迹与路径', 'Phase trajectory and path'],
  region: ['可行域与稳定域', 'Feasible and stability region'],
  network: ['网络拓扑', 'Network topology'],
  stacked: ['堆叠对照', 'Stacked comparison'],
  radar: ['雷达图', 'Radar chart'],
  polar: ['极坐标图', 'Polar plot'],
  confusion: ['混淆矩阵', 'Confusion matrix'],
  flow: ['流量与桑基图', 'Flow and Sankey diagram'],
  chord: ['弦图', 'Chord diagram'],
  pareto: ['帕累托前沿', 'Pareto frontier'],
  tornado: ['龙卷风图', 'Tornado chart'],
  ternary: ['三元图', 'Ternary plot'],
  pie: ['占比与环形图', 'Pie and donut chart'],
  calendar: ['日历热图', 'Calendar heatmap'],
  raster: ['栅格时空图', 'Space-time raster'],
  waterfall: ['瀑布图', 'Waterfall chart'],
  vector: ['矢量场', 'Vector field'],
  embedding: ['嵌入投影', 'Embedding projection'],
  spatiotemporal: ['时空演化', 'Spatiotemporal comparison'],
  interval: ['点估计与区间', 'Point and interval plot'],
  roc: ['ROC 与精确率召回率', 'ROC and precision–recall curves'],
  ablation: ['消融比较', 'Ablation comparison'],
  scenario: ['情景对照', 'Scenario comparison'],
  multipanel: ['多面板联图', 'Multi-panel comparison'],
  bar3d: ['三维柱状图', '3D bar chart'],
  parallel: ['平行坐标', 'Parallel coordinates'],
  ridgeline: ['山脊分布图', 'Ridgeline plot'],
  forest: ['森林图', 'Forest plot'],
  windrose: ['风玫瑰图', 'Wind rose'],
  treemap: ['矩形树图', 'Treemap'],
  mosaic: ['马赛克图', 'Mosaic plot'],
};

export function studyDimension(row: PaperFigure): StudyDimension | 'mixed' | undefined {
  const dims = row.supplement?.dimensions;
  if (!dims?.length) return undefined;
  return dims.includes('2d') && dims.includes('3d') ? 'mixed' : dims[0];
}

export function citationFromFigure({ id, title, authors, venue, year, paper, pdf_source, figure, page, doi, figureUrl }: PaperCitation): PaperCitation {
  return { id, title, authors, venue, year, paper, ...(pdf_source && { pdf_source }), ...(figure && { figure }), ...(page && { page }),
    ...(doi && { doi }), ...(figureUrl && { figureUrl }) };
}

export function paperFigureName(row: PaperCitation) {
  return row.figure ? row.title + ' · ' + row.figure : row.title;
}
