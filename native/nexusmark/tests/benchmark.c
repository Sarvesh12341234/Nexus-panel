#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

struct sample {
  double microseconds;
  long max_rss_kib;
};

static double elapsed_us(const struct timespec *start, const struct timespec *end) {
  return (end->tv_sec - start->tv_sec) * 1000000.0 + (end->tv_nsec - start->tv_nsec) / 1000.0;
}

static int compare_double(const void *left, const void *right) {
  double a = *(const double *)left;
  double b = *(const double *)right;
  return (a > b) - (a < b);
}

static int execute_once(const char *wrapper, const char *root, const char *payload, int sandboxed, struct sample *sample) {
  struct timespec started, ended;
  struct rusage usage;
  clock_gettime(CLOCK_MONOTONIC, &started);
  pid_t child = fork();
  if (child < 0) return -1;
  if (child == 0) {
    if (chdir(root) < 0) _exit(126);
    int null_fd = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (null_fd >= 0) {
      dup2(null_fd, STDERR_FILENO);
      if (null_fd > STDERR_FILENO) close(null_fd);
    }
    if (sandboxed) execl(wrapper, wrapper, "--root", root, "--port", "65535", "--", payload, (char *)NULL);
    else execl(payload, payload, (char *)NULL);
    _exit(127);
  }
  int status = 0;
  if (wait4(child, &status, 0, &usage) < 0) return -1;
  clock_gettime(CLOCK_MONOTONIC, &ended);
  sample->microseconds = elapsed_us(&started, &ended);
  sample->max_rss_kib = usage.ru_maxrss;
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

static int run_set(const char *name, const char *wrapper, const char *root, const char *payload, int sandboxed, int iterations) {
  double *durations = calloc((size_t)iterations, sizeof(double));
  if (!durations) return -1;
  double total = 0.0;
  long maximum_rss = 0;
  int failures = 0;
  for (int i = 0; i < iterations + 10; i++) {
    struct sample sample = { 0 };
    if (execute_once(wrapper, root, payload, sandboxed, &sample) < 0) {
      if (i >= 10) failures++;
      continue;
    }
    if (i < 10) continue;
    durations[i - 10] = sample.microseconds;
    total += sample.microseconds;
    if (sample.max_rss_kib > maximum_rss) maximum_rss = sample.max_rss_kib;
  }
  qsort(durations, (size_t)iterations, sizeof(double), compare_double);
  printf("BENCH name=%s iterations=%d failures=%d mean_us=%.2f p50_us=%.2f p95_us=%.2f max_rss_kib=%ld\n",
    name, iterations, failures, total / iterations, durations[iterations / 2],
    durations[(iterations * 95) / 100], maximum_rss);
  free(durations);
  return failures ? -1 : 0;
}

int main(int argc, char **argv) {
  if (argc < 3 || argc > 5) {
    fprintf(stderr, "usage: %s <nexusmark-native> <server-root> [iterations] [payload]\n", argv[0]);
    return 64;
  }
  int iterations = argc == 4 ? atoi(argv[3]) : 300;
  if (argc == 5) iterations = atoi(argv[3]);
  if (iterations < 20 || iterations > 10000) return 64;
  const char *payload = argc == 5 ? argv[4] : "/bin/true";
  int direct = run_set("direct-exec", argv[1], argv[2], payload, 0, iterations);
  int sandbox = run_set("nexusmark", argv[1], argv[2], payload, 1, iterations);
  return direct || sandbox ? 1 : 0;
}
