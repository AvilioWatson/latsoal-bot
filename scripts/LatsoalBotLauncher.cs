using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

namespace LatsoalBotLauncher
{
    internal static class Program
    {
        private const string AppUrl = "http://127.0.0.1:8765";
        private const int AppPort = 8765;

        private static int Main()
        {
            string root = FindProjectRoot();
            if (root == null)
            {
                Console.Error.WriteLine("server.js tidak ditemukan. Jalankan LatsoalBot.exe dari folder project latsoal-bot.");
                return 1;
            }

            if (!CommandExists("node"))
            {
                Console.Error.WriteLine("Node.js belum tersedia di PATH. Install Node.js atau jalankan dari terminal yang sudah mengenali node.");
                return 1;
            }

            StopExistingServers();
            StartServer(root);

            if (!WaitForServer())
            {
                Console.Error.WriteLine("Server belum siap. Coba jalankan manual: npm.cmd start");
                return 1;
            }

            OpenBrowser(AppUrl);
            Console.WriteLine("Latsoal Bot berjalan di " + AppUrl);
            Console.WriteLine("Tutup window server Node.js jika ingin menghentikan aplikasi.");
            return 0;
        }

        private static void StopExistingServers()
        {
            foreach (int processId in FindListeningProcessIds(AppPort))
            {
                try
                {
                    Process process = Process.GetProcessById(processId);
                    string name = process.ProcessName ?? "";
                    if (!name.Equals("node", StringComparison.OrdinalIgnoreCase) &&
                        !name.Equals("node.exe", StringComparison.OrdinalIgnoreCase))
                    {
                        Console.WriteLine("Port " + AppPort + " dipakai proses non-Node: " + name + " (" + processId + ").");
                        continue;
                    }

                    Console.WriteLine("Menghentikan server Node.js lama: PID " + processId);
                    process.Kill();
                    process.WaitForExit(5000);
                }
                catch (Exception error)
                {
                    Console.WriteLine("Gagal menghentikan proses lama PID " + processId + ": " + error.Message);
                }
            }
        }

        private static IEnumerable<int> FindListeningProcessIds(int port)
        {
            List<int> processIds = new List<int>();
            try
            {
                using (Process process = Process.Start(new ProcessStartInfo
                {
                    FileName = "netstat.exe",
                    Arguments = "-ano -p tcp",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(5000);
                    string marker = ":" + port;
                    foreach (string rawLine in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        string line = rawLine.Trim();
                        if (!line.StartsWith("TCP", StringComparison.OrdinalIgnoreCase) ||
                            line.IndexOf(marker, StringComparison.OrdinalIgnoreCase) < 0 ||
                            line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            continue;
                        }

                        string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        int processId;
                        if (parts.Length >= 5 && int.TryParse(parts[parts.Length - 1], out processId) && !processIds.Contains(processId))
                        {
                            processIds.Add(processId);
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Console.WriteLine("Tidak bisa mengecek server lama di port " + port + ": " + error.Message);
            }
            return processIds;
        }

        private static string FindProjectRoot()
        {
            string current = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 4 && !string.IsNullOrEmpty(current); i++)
            {
                if (File.Exists(Path.Combine(current, "server.js")) && File.Exists(Path.Combine(current, "content_generator.py")))
                {
                    return current;
                }
                DirectoryInfo parent = Directory.GetParent(current);
                current = parent == null ? null : parent.FullName;
            }
            return null;
        }

        private static bool CommandExists(string command)
        {
            try
            {
                using (Process process = Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c where " + command,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }))
                {
                    process.WaitForExit(3000);
                    return process.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartServer(string root)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"node server.js\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Minimized
            };
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("LATSOAL_RENDER_ENGINE")))
            {
                startInfo.EnvironmentVariables["LATSOAL_RENDER_ENGINE"] = "pil";
            }
            Process.Start(startInfo);
        }

        private static bool WaitForServer()
        {
            for (int i = 0; i < 30; i++)
            {
                if (IsServerReady())
                {
                    return true;
                }
                Thread.Sleep(500);
            }
            return false;
        }

        private static bool IsServerReady()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(AppUrl + "/health");
                request.Timeout = 1000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void OpenBrowser(string url)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
    }
}
