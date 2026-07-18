#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
  const size_t size = 8U * 1024U * 1024U;
  unsigned char *buffer = malloc(size);
  if (!buffer) return 1;
  uint64_t state = 0xcbf29ce484222325ULL;
  for (size_t i = 0; i < size; i++) {
    state ^= (uint64_t)(i * 131U);
    state *= 0x100000001b3ULL;
    buffer[i] = (unsigned char)(state >> 24);
  }
  int file = open("benchmark-workload.tmp", O_RDWR | O_CREAT | O_TRUNC, 0600);
  if (file < 0) return 2;
  size_t written = 0;
  while (written < size) {
    ssize_t amount = write(file, buffer + written, size - written);
    if (amount <= 0) return 3;
    written += (size_t)amount;
  }
  if (lseek(file, 0, SEEK_SET) < 0) return 4;
  size_t read_bytes = 0;
  while (read_bytes < size) {
    ssize_t amount = read(file, buffer + read_bytes, size - read_bytes);
    if (amount <= 0) return 5;
    read_bytes += (size_t)amount;
  }
  close(file);
  unlink("benchmark-workload.tmp");
  free(buffer);
  return state == 0 ? 6 : 0;
}
