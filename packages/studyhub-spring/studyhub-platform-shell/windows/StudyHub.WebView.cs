using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
    [STAThread] static int Main(string[] args) {
        Uri origin;
        if (args.Length != 2 || !Uri.TryCreate(args[0], UriKind.Absolute, out origin)
                || origin.Scheme != "http" || !origin.IsLoopback) return 2;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var window = new Form { Text = "StudyHub", Width = 1280, Height = 820 })
        using (var web = new WebView2 { Dock = DockStyle.Fill })
        using (var menu = new ContextMenuStrip())
        using (var tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "StudyHub", Visible = true, ContextMenuStrip = menu }) {
            bool quitting = false;
            Action show = () => { window.Show(); window.WindowState = FormWindowState.Normal; window.Activate(); };
            menu.Items.Add("StudyHub", null, (s, e) => show());
            menu.Items.Add("Exit", null, (s, e) => { quitting = true; window.Close(); });
            tray.DoubleClick += (s, e) => show();
            window.FormClosing += (s, e) => {
                if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; window.Hide(); }
            };
            window.Controls.Add(web);
            window.Shown += async (s, e) => {
                // The JVM owns stdin. Closing it, including after a JVM crash, closes the tray and window.
                var parent = Task.Run(() => {
                    using (var stdin = Console.OpenStandardInput()) { while (stdin.ReadByte() >= 0) {} }
                    if (!window.IsDisposed) {
                        try { window.BeginInvoke((Action)(() => { quitting = true; window.Close(); })); }
                        catch (InvalidOperationException) { }
                    }
                });
                try {
                    var env = await CoreWebView2Environment.CreateAsync(null, args[1], null);
                    await web.EnsureCoreWebView2Async(env);
                    web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
                    web.CoreWebView2.NavigationStarting += (sender, nav) => {
                        Uri target;
                        nav.Cancel = !Uri.TryCreate(nav.Uri, UriKind.Absolute, out target) || target.GetLeftPart(UriPartial.Authority) != origin.GetLeftPart(UriPartial.Authority);
                    };
                    web.CoreWebView2.NewWindowRequested += (sender, nav) => { nav.Handled = true; };
                    web.Source = origin;
                } catch (Exception failure) {
                    MessageBox.Show(window, failure.Message, "StudyHub WebView2");
                    quitting = true;
                    window.Close();
                }
            };
            Application.Run(window);
            tray.Visible = false;
        }
        return 0;
    }
}
