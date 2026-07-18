#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define AGENT_VERSION "3.0.0"
#define SOCKET_PATH "/run/nexuspanel/host-agent.sock"
#define BUFFER_SIZE 512

static volatile sig_atomic_t running = 1;

static void stop_agent(int signal_number) {
  (void)signal_number;
  running = 0;
}

static double read_number(const char *path) {
  FILE *file = fopen(path, "r");
  double value = 0.0;
  if (file != NULL) {
    if (fscanf(file, "%lf", &value) != 1) value = 0.0;
    fclose(file);
  }
  return value;
}

static unsigned long long memory_available_kb(void) {
  FILE *file = fopen("/proc/meminfo", "r");
  char key[64];
  unsigned long long value = 0;
  char unit[16];
  if (file == NULL) return 0;
  while (fscanf(file, "%63s %llu %15s", key, &value, unit) == 3) {
    if (strcmp(key, "MemAvailable:") == 0) {
      fclose(file);
      return value;
    }
  }
  fclose(file);
  return 0;
}

static void status_json(char *output, size_t output_size) {
  struct statvfs disk;
  unsigned long long free_bytes = 0;
  if (statvfs("/", &disk) == 0) {
    free_bytes = (unsigned long long)disk.f_bavail * (unsigned long long)disk.f_frsize;
  }
  snprintf(output, output_size,
    "{\"ok\":true,\"agent\":\"nexus-host-agent\",\"version\":\"%s\",\"pid\":%ld,\"uptimeSeconds\":%.0f,\"load1\":%.3f,\"memoryAvailableBytes\":%llu,\"diskFreeBytes\":%llu}",
    AGENT_VERSION, (long)getpid(), read_number("/proc/uptime"), read_number("/proc/loadavg"),
    memory_available_kb() * 1024ULL, free_bytes);
}

static void handle_client(int client) {
  char input[BUFFER_SIZE] = {0};
  char output[BUFFER_SIZE] = {0};
  ssize_t length = read(client, input, sizeof(input) - 1);
  if (length <= 0) return;
  input[strcspn(input, "\r\n")] = '\0';
  if (strcmp(input, "PING") == 0) {
    snprintf(output, sizeof(output), "{\"ok\":true,\"pong\":true,\"version\":\"%s\"}", AGENT_VERSION);
  } else if (strcmp(input, "STATUS") == 0) {
    status_json(output, sizeof(output));
  } else if (strcmp(input, "VERSION") == 0) {
    snprintf(output, sizeof(output), "{\"ok\":true,\"version\":\"%s\"}", AGENT_VERSION);
  } else {
    snprintf(output, sizeof(output), "{\"ok\":false,\"error\":\"unsupported command\"}");
  }
  size_t total = 0;
  size_t output_length = strlen(output);
  while (total < output_length) {
    ssize_t sent = write(client, output + total, output_length - total);
    if (sent <= 0) return;
    total += (size_t)sent;
  }
  if (write(client, "\n", 1) < 0) return;
}

int main(int argc, char **argv) {
  int server;
  struct sockaddr_un address;
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts(AGENT_VERSION);
    return 0;
  }
  signal(SIGTERM, stop_agent);
  signal(SIGINT, stop_agent);
  signal(SIGPIPE, SIG_IGN);
  umask(0007);
  server = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (server < 0) return 1;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  strncpy(address.sun_path, SOCKET_PATH, sizeof(address.sun_path) - 1);
  unlink(SOCKET_PATH);
  if (bind(server, (struct sockaddr *)&address, sizeof(address)) < 0) return 2;
  if (chmod(SOCKET_PATH, 0660) < 0) return 3;
  if (listen(server, 64) < 0) return 4;
  while (running) {
    int client = accept4(server, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0) {
      if (errno == EINTR) continue;
      break;
    }
    handle_client(client);
    close(client);
  }
  close(server);
  unlink(SOCKET_PATH);
  return 0;
}
