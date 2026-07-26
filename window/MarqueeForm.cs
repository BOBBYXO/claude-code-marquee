// Claude Code 跑马灯 - 悬浮小窗(多会话合并版)
// 一个窗, 每个会话占一行: [大灯] [灯带] [状态文字·项目名]
// 通信: 读 state 文件, 每行一个会话 "STATE|项目名", 多行=多会话
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.IO;
using System.Runtime.InteropServices;

namespace ClaudeMarquee
{
    static class Program
    {
        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int value);

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDpiAwareness(2); } catch { }

            // args: [0]=state文件 [1]=初始x [2]=初始y
            string stateFile = args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "state.txt");
            int x = 120, y = 120;
            if (args.Length > 1) int.TryParse(args[1], out x);
            if (args.Length > 2) int.TryParse(args[2], out y);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MarqueeForm(stateFile, x, y));
        }
    }

    class MarqueeForm : Form
    {
        private readonly string stateFile;
        private readonly Timer pollTimer;
        private readonly Timer animTimer;
        private int animTick = 0;

        private class SessionRow
        {
            public Rectangle bigDot;
            public Rectangle[] segs;
            public Color[] segColors;
            public Color bigColor;
            public string state = "IDLE";
            public string text = "空闲";
        }
        private List<SessionRow> rows = new List<SessionRow>();

        private struct StateCfg { public Color color; public string label; public string anim; }
        private static readonly Dictionary<string, StateCfg> STATE =
            new Dictionary<string, StateCfg>
            {
                { "THINKING",      new StateCfg { color = Color.FromArgb(56,139,253),  label = "Claude 思考中",  anim = "flow" } },
                { "TOOL_RUNNING",  new StateCfg { color = Color.FromArgb(251,146,60),  label = "执行工具",      anim = "rotate" } },
                { "WAITING_INPUT", new StateCfg { color = Color.FromArgb(52,211,153),  label = "等待输入",      anim = "breathe" } },
                { "ERROR",         new StateCfg { color = Color.FromArgb(248,113,113), label = "出错",          anim = "flicker" } },
                { "IDLE",          new StateCfg { color = Color.FromArgb(34,211,238),  label = "空闲",          anim = "dim" } },
            };

        // 布局常量
        private const int bigD = 40;          // 大灯直径
        private const int segD = 22;          // 灯带段直径
        private const int segGap = 6;         // 灯带段间距
        private const int lampCount = 8;
        private const int padL = 24;          // 左边距
        private const int padV = 20;          // 上下边距
        private const int rowGap = 22;        // 会话行间距
        private const int segTextGap = 10;    // 灯带与文字的垂直间距
        private const int textH = 18;         // 文字行高度
        private const int afterBig = padL + bigD + 22;
        private const int textW = 320;
        private static readonly int lampTotalW = lampCount * segD + (lampCount - 1) * segGap;
        private static readonly int rowH = segD + segTextGap + textH;

        // 窗口阴影(DWM 原生阴影, 兼容圆角 Region)
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        private const int DWMWA_MICA_EFFECT = 1029;
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWCP_ROUND = 2;
        private const int DWMWA_NCRENDERING_POLICY = 2;
        private const int DWMNCRP_DISABLED = 2;

        public MarqueeForm(string stateFile, int x = 120, int y = 120)
        {
            this.stateFile = stateFile;

            this.Text = "";
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.Location = new Point(x, y);
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.BackColor = Color.FromArgb(13, 17, 23);
            this.DoubleBuffered = true;
            this.MinimumSize = new Size(320, 48);

            RebuildRows(new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("IDLE", "等待会话") });

            this.MouseDown += OnMouseDown;
            this.MouseMove += OnMouseMove;
            this.MouseUp += OnMouseUp;

            pollTimer = new Timer();
            pollTimer.Interval = 500;
            pollTimer.Tick += (s, e) => PollState();
            pollTimer.Start();

            animTimer = new Timer();
            animTimer.Interval = 90;     // 提高帧率, 动画更流畅
            animTimer.Tick += (s, e) => { animTick++; this.Invalidate(); };
            animTimer.Start();

            PollState();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // 禁用 DWM 系统边框(消除无边框窗口上 1px 白线)
            int ncPolicy = DWMNCRP_DISABLED;
            try { DwmSetWindowAttribute(this.Handle, DWMWA_NCRENDERING_POLICY, ref ncPolicy, 4); } catch { }
            // 暗色模式
            int dark = 1;
            try { DwmSetWindowAttribute(this.Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, 4); } catch { }
            // 圆角
            int radius = 48;
            this.Region = new Region(RoundedRect(new Rectangle(0, 0, this.Width, this.Height), radius));
        }

        private void RebuildRows(List<KeyValuePair<string, string>> entries)
        {
            rows.Clear();
            for (int i = 0; i < entries.Count; i++)
            {
                string st = entries[i].Key;
                string project = entries[i].Value;
                if (!STATE.ContainsKey(st)) st = "IDLE";
                var cfg = STATE[st];

                var row = new SessionRow();
                int yTop = padV + i * (rowH + rowGap);
                row.bigDot = new Rectangle(padL, yTop + (rowH - bigD) / 2, bigD, bigD);
                row.bigColor = cfg.color;
                row.segs = new Rectangle[lampCount];
                for (int k = 0; k < lampCount; k++)
                    row.segs[k] = new Rectangle(afterBig + k * (segD + segGap), yTop, segD, segD);
                row.segColors = new Color[lampCount];
                row.state = st;
                row.text = string.IsNullOrEmpty(project) ? cfg.label : (cfg.label + "  ·  " + project);
                rows.Add(row);
            }

            int contentW = afterBig + Math.Max(lampTotalW, textW) + padL;
            int realH = padV * 2 + rows.Count * rowH + (rows.Count - 1) * rowGap;
            this.Size = new Size(contentW, realH);
            if (this.IsHandleCreated)
            {
                int radius = 48;
                this.Region = new Region(RoundedRect(new Rectangle(0, 0, this.Width, this.Height), radius));
            }
        }

        private void PollState()
        {
            var entries = new List<KeyValuePair<string, string>>();
            try
            {
                if (File.Exists(stateFile))
                {
                    string text = File.ReadAllText(stateFile);
                    foreach (string line in text.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        string ln = line.Trim();
                        if (string.IsNullOrEmpty(ln)) continue;
                        string[] parts = ln.Split(new char[] { '|' }, 2);
                        string st = parts[0].Trim();
                        string project = parts.Length > 1 ? parts[1].Trim() : "";
                        if (STATE.ContainsKey(st))
                            entries.Add(new KeyValuePair<string, string>(st, project));
                    }
                }
            }
            catch { }

            if (entries.Count == 0)
                entries.Add(new KeyValuePair<string, string>("IDLE", "等待会话"));

            bool needRebuild = entries.Count != rows.Count;
            if (!needRebuild)
            {
                for (int i = 0; i < entries.Count; i++)
                {
                    if (entries[i].Key != rows[i].state || entries[i].Value != ExtractProject(rows[i].text))
                    {
                        var cfg = STATE[entries[i].Key];
                        rows[i].state = entries[i].Key;
                        rows[i].bigColor = cfg.color;
                        rows[i].text = string.IsNullOrEmpty(entries[i].Value) ? cfg.label : (cfg.label + "  ·  " + entries[i].Value);
                    }
                }
            }
            else
            {
                RebuildRows(entries);
            }
        }

        private static string ExtractProject(string text)
        {
            int idx = text.IndexOf("  ·  ");
            return idx >= 0 ? text.Substring(idx + 5) : "";
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;

            // 背景渐变: 从上到下微妙的深浅变化
            int bgH = this.ClientSize.Height;
            using (var bgBrush = new LinearGradientBrush(
                new Point(0, 0), new Point(0, bgH),
                Color.FromArgb(15, 20, 26), Color.FromArgb(11, 15, 20)))
            {
                g.FillRectangle(bgBrush, this.ClientRectangle);
            }

            // 窗口边框(半径 47 = 48-1, 与窗口圆角同心)
            int borderR = 47;
            using (var borderPath = RoundedRect(new Rectangle(1, 1, this.Width - 3, this.Height - 3), borderR))
            {
                // 极淡描边: 几乎不可见, 仅勾勒轮廓
                using (var pen = new Pen(Color.FromArgb(35, 180, 190, 200), 2))
                {
                    g.DrawPath(pen, borderPath);
                }
            }

            // 每行
            for (int r = 0; r < rows.Count; r++)
            {
                var row = rows[r];
                var cfg = STATE[row.state];

                // 会话行之间的分隔线(不画第一行上方)
                if (r > 0)
                {
                    int sepY = row.segs[0].Top - rowGap / 2;
                    using (var pen = new Pen(Color.FromArgb(25, 255, 255, 255), 1))
                    {
                        g.DrawLine(pen, padL + bigD + 8, sepY, this.Width - padL, sepY);
                    }
                }

                // 灯带
                Color[] colors = ComputeSegColors(cfg, r);
                for (int k = 0; k < row.segs.Length; k++)
                    DrawGlowDot(g, row.segs[k], colors[k]);

                // 大灯
                DrawGlowDot(g, row.bigDot, row.bigColor, 1.5, isBig: true);

                // 文字
                using (var font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold))
                using (var brush = new SolidBrush(Color.FromArgb(210, 216, 224)))
                {
                    int textY = row.segs[0].Bottom + segTextGap;
                    g.DrawString(row.text, font, brush, afterBig, textY);
                }
            }
        }

        private Color[] ComputeSegColors(StateCfg cfg, int rowIdx)
        {
            Color[] colors = new Color[lampCount];
            switch (cfg.anim)
            {
                case "flow":
                    for (int i = 0; i < lampCount; i++)
                    {
                        int lit = (animTick + rowIdx) % lampCount;
                        int dist = (i - lit + lampCount) % lampCount;
                        colors[i] = dist == 0 ? cfg.color : Dim(cfg.color, 0.15);
                    }
                    break;
                case "rotate":
                    for (int i = 0; i < lampCount; i++)
                    {
                        int phase = (animTick + i + rowIdx) % lampCount;
                        double b = 0.15 + 0.85 * Math.Max(0, Math.Cos((phase - 2) * 0.9));
                        colors[i] = Dim(cfg.color, b);
                    }
                    break;
                case "breathe":
                    {
                        double b = 0.25 + 0.6 * (0.5 + 0.5 * Math.Sin((animTick + rowIdx) * 0.25));
                        for (int i = 0; i < lampCount; i++) colors[i] = Dim(cfg.color, b);
                    }
                    break;
                case "flicker":
                    {
                        bool on = ((animTick + rowIdx) % 4) < 2;
                        for (int i = 0; i < lampCount; i++) colors[i] = on ? cfg.color : Dim(cfg.color, 0.15);
                    }
                    break;
                default:
                    for (int i = 0; i < lampCount; i++) colors[i] = Dim(cfg.color, 0.18);
                    break;
            }
            return colors;
        }

        private static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            path.AddArc(r.X, r.Y, radius, radius, 180, 90);
            path.AddArc(r.Right - radius, r.Y, radius, radius, 270, 90);
            path.AddArc(r.Right - radius, r.Bottom - radius, radius, radius, 0, 90);
            path.AddArc(r.X, r.Bottom - radius, radius, radius, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void DrawGlowDot(Graphics g, Rectangle rect, Color color, double glowScale = 1.0, bool isBig = false)
        {
            int cx = rect.X + rect.Width / 2;
            int cy = rect.Y + rect.Height / 2;
            int r = rect.Width / 2;

            // 外层光晕(更柔和、扩散更宽)
            int glowLayers = isBig ? 6 : 4;
            for (int k = glowLayers; k >= 1; k--)
            {
                int gr = r + k * (isBig ? 4 : 3);
                int alpha = (int)((isBig ? 14 : 10) * glowScale / (k * 0.8 + 0.2));
                if (alpha < 2) continue;
                using (var brush = new SolidBrush(Color.FromArgb(Math.Min(alpha, 60), color)))
                    g.FillEllipse(brush, cx - gr, cy - gr, gr * 2, gr * 2);
            }

            // 主体(带微弱外圈)
            using (var brush = new SolidBrush(color))
                g.FillEllipse(brush, rect);

            // 高光: 左上偏白, 圆形, 让灯有立体感
            int hs = (int)(rect.Width * 0.42);
            int hx = rect.X + (rect.Width - hs) / 2 + 1;
            int hy = rect.Y + (rect.Height - hs) / 2 + 1;
            using (var brush = new SolidBrush(Color.FromArgb(120, 255, 255, 255)))
            {
                g.FillEllipse(brush, hx, hy, hs, hs);
            }
            // 第二层高光: 更小更亮的核心点
            int hs2 = (int)(rect.Width * 0.2);
            int hx2 = rect.X + (rect.Width - hs2) / 2 + 2;
            int hy2 = rect.Y + (rect.Height - hs2) / 2 + 1;
            using (var brush = new SolidBrush(Color.FromArgb(200, 255, 255, 255)))
            {
                g.FillEllipse(brush, hx2, hy2, hs2, hs2);
            }
        }

        private static Color Dim(Color c, double factor)
        {
            return Color.FromArgb((int)(c.R * factor), (int)(c.G * factor), (int)(c.B * factor));
        }

        // 拖动 + 右键关闭
        private bool dragging = false;
        private Point dragOffset;
        private void OnMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right) { this.Close(); return; }
            if (e.Button == MouseButtons.Left) { dragging = true; dragOffset = e.Location; }
        }
        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            if (dragging)
            {
                Point now = this.PointToScreen(e.Location);
                this.Location = new Point(now.X - dragOffset.X, now.Y - dragOffset.Y);
            }
        }
        private void OnMouseUp(object sender, MouseEventArgs e) { dragging = false; }
    }
}
