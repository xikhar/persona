#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> running{true};

AudioObjectPropertyAddress propertyAddress(
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal,
    AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}

void emitJSON(NSDictionary *object) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int fail(NSString *message, OSStatus status = noErr) {
  NSString *detail = message;
  if (status != noErr) {
    detail = [NSString stringWithFormat:@"%@ (OSStatus %d)", message, status];
  }
  emitJSON(@{@"type" : @"error", @"message" : detail});
  return 1;
}

void handleSignal(int) {
  running.store(false, std::memory_order_relaxed);
}

std::vector<AudioObjectID> audioProcessObjects(
    const std::vector<pid_t>& requestedPids,
    std::vector<pid_t>* resolvedPids = nullptr) {
  auto address = propertyAddress(kAudioHardwarePropertyProcessObjectList);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(
          kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) {
    return {};
  }
  std::vector<AudioObjectID> objects(size / sizeof(AudioObjectID));
  if (objects.empty() ||
      AudioObjectGetPropertyData(
          kAudioObjectSystemObject, &address, 0, nullptr, &size, objects.data()) != noErr) {
    return {};
  }
  objects.resize(size / sizeof(AudioObjectID));

  std::vector<AudioObjectID> matches;
  for (AudioObjectID object : objects) {
    auto pidAddress = propertyAddress(kAudioProcessPropertyPID);
    pid_t pid = 0;
    UInt32 pidSize = sizeof(pid);
    if (AudioObjectGetPropertyData(object, &pidAddress, 0, nullptr, &pidSize, &pid) != noErr) {
      continue;
    }
    if (std::find(requestedPids.begin(), requestedPids.end(), pid) != requestedPids.end()) {
      matches.push_back(object);
      if (resolvedPids != nullptr) resolvedPids->push_back(pid);
    }
  }
  return matches;
}

struct MeterContext {
  AudioStreamBasicDescription format{};
  std::atomic<float> peak{0.0f};
};

double squareSumForBuffer(
    const AudioBuffer& buffer,
    const AudioStreamBasicDescription& format,
    std::size_t& sampleCount) {
  if (buffer.mData == nullptr || buffer.mDataByteSize == 0) return 0.0;
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSigned = (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  double sum = 0.0;

  if (isFloat && format.mBitsPerChannel == 32) {
    const auto *samples = static_cast<const float *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(float);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = std::isfinite(samples[index]) ? samples[index] : 0.0;
      sum += sample * sample;
    }
  } else if (isFloat && format.mBitsPerChannel == 64) {
    const auto *samples = static_cast<const double *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(double);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = std::isfinite(samples[index]) ? samples[index] : 0.0;
      sum += sample * sample;
    }
  } else if (isSigned && format.mBitsPerChannel == 16) {
    const auto *samples = static_cast<const int16_t *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(int16_t);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = static_cast<double>(samples[index]) / 32768.0;
      sum += sample * sample;
    }
  } else if (isSigned && format.mBitsPerChannel == 32) {
    const auto *samples = static_cast<const int32_t *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(int32_t);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = static_cast<double>(samples[index]) / 2147483648.0;
      sum += sample * sample;
    }
  }
  return sum;
}

OSStatus meterIOProc(
    AudioObjectID,
    const AudioTimeStamp *,
    const AudioBufferList *input,
    const AudioTimeStamp *,
    AudioBufferList *,
    const AudioTimeStamp *,
    void *clientData) {
  auto *context = static_cast<MeterContext *>(clientData);
  if (input == nullptr || context == nullptr) return noErr;

  double squareSum = 0.0;
  std::size_t sampleCount = 0;
  for (UInt32 index = 0; index < input->mNumberBuffers; ++index) {
    std::size_t bufferSamples = 0;
    squareSum += squareSumForBuffer(input->mBuffers[index], context->format, bufferSamples);
    sampleCount += bufferSamples;
  }
  if (sampleCount == 0) return noErr;

  const double rms = std::sqrt(squareSum / static_cast<double>(sampleCount));
  const float level =
      static_cast<float>(std::clamp((rms - 0.0025) * 7.5, 0.0, 1.0));
  float previous = context->peak.load(std::memory_order_relaxed);
  while (level > previous &&
         !context->peak.compare_exchange_weak(
             previous, level, std::memory_order_relaxed, std::memory_order_relaxed)) {
  }
  return noErr;
}

}  // namespace

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    std::vector<pid_t> processIds;
    for (int index = 1; index < argc; ++index) {
      if (strcmp(argv[index], "--self-test") == 0) {
        emitJSON(@{@"type" : @"ready", @"source" : @"macOS self-test"});
        return 0;
      }
      if (strcmp(argv[index], "--pid") == 0 && index + 1 < argc) {
        const long value = strtol(argv[++index], nullptr, 10);
        if (value > 0) processIds.push_back(static_cast<pid_t>(value));
      }
    }
    if (processIds.empty()) return fail(@"At least one --pid is required.");

    std::vector<pid_t> resolvedPids;
    const auto processObjects = audioProcessObjects(processIds, &resolvedPids);
    if (processObjects.empty()) {
      return fail(@"No active Core Audio process matches the requested application.");
    }

    NSMutableArray<NSNumber *> *processNumbers =
        [NSMutableArray arrayWithCapacity:processObjects.size()];
    for (AudioObjectID object : processObjects) {
      [processNumbers addObject:@(object)];
    }
    CATapDescription *tapDescription =
        [[CATapDescription alloc] initStereoMixdownOfProcesses:processNumbers];
    if (tapDescription == nil) {
      return fail(@"Unable to configure the Core Audio process tap.");
    }
    tapDescription.name = @"Persona voice output meter";
    [tapDescription setPrivate:YES];

    AudioObjectID tapID = kAudioObjectUnknown;
    OSStatus status = AudioHardwareCreateProcessTap(tapDescription, &tapID);
    if (status != noErr) return fail(@"Unable to create a Core Audio process tap.", status);

    CFStringRef tapUIDRef = nullptr;
    auto tapUIDAddress = propertyAddress(kAudioTapPropertyUID);
    UInt32 tapUIDSize = sizeof(tapUIDRef);
    status = AudioObjectGetPropertyData(
        tapID, &tapUIDAddress, 0, nullptr, &tapUIDSize, &tapUIDRef);
    if (status != noErr || tapUIDRef == nullptr) {
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"Unable to read the Core Audio tap identifier.", status);
    }
    NSString *tapUID = [(__bridge NSString *)tapUIDRef copy];
    CFRelease(tapUIDRef);

    NSString *aggregateUID = [NSString stringWithFormat:@"com.xikhar.persona.%@",
                                                        NSUUID.UUID.UUIDString];
    NSDictionary *aggregateDescription = @{
      @kAudioAggregateDeviceNameKey : @"Persona Output Meter",
      @kAudioAggregateDeviceUIDKey : aggregateUID,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
      @kAudioAggregateDeviceTapAutoStartKey : @YES,
    };
    AudioObjectID aggregateID = kAudioObjectUnknown;
    status = AudioHardwareCreateAggregateDevice(
        (__bridge CFDictionaryRef)aggregateDescription, &aggregateID);
    if (status != noErr) {
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"Unable to create a private Core Audio aggregate device.", status);
    }

    CFArrayRef tapList = (__bridge CFArrayRef)@[ tapUID ];
    auto tapListAddress = propertyAddress(kAudioAggregateDevicePropertyTapList);
    UInt32 tapListSize = sizeof(tapList);
    status = AudioObjectSetPropertyData(
        aggregateID, &tapListAddress, 0, nullptr, tapListSize, &tapList);
    if (status != noErr) {
      AudioHardwareDestroyAggregateDevice(aggregateID);
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"Unable to attach the process tap to its aggregate device.", status);
    }

    MeterContext meter;
    // Core Audio publishes the aggregate device's tapped input stream
    // asynchronously after the tap list is attached. Reading the format on the
    // first attempt races that setup and intermittently fails with
    // kAudioHardwareBadObjectError, so poll both scopes until the stream
    // appears rather than giving up immediately.
    const AudioObjectPropertyScope formatScopes[] = {
        kAudioDevicePropertyScopeInput,
        kAudioObjectPropertyScopeGlobal,
    };
    status = kAudioHardwareBadObjectError;
    const auto formatDeadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (true) {
      for (const AudioObjectPropertyScope scope : formatScopes) {
        auto formatAddress =
            propertyAddress(kAudioDevicePropertyStreamFormat, scope);
        UInt32 formatSize = sizeof(meter.format);
        const OSStatus readStatus = AudioObjectGetPropertyData(
            aggregateID, &formatAddress, 0, nullptr, &formatSize, &meter.format);
        if (readStatus == noErr && meter.format.mSampleRate > 0 &&
            meter.format.mBitsPerChannel > 0) {
          status = noErr;
          break;
        }
        status = readStatus != noErr ? readStatus : kAudioHardwareBadObjectError;
      }
      if (status == noErr) break;
      if (std::chrono::steady_clock::now() >= formatDeadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }

    if (status != noErr) {
      AudioHardwareDestroyAggregateDevice(aggregateID);
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"Unable to read the tapped stream format.", status);
    }

    AudioDeviceIOProcID ioProcID = nullptr;
    status = AudioDeviceCreateIOProcID(aggregateID, meterIOProc, &meter, &ioProcID);
    if (status == noErr) status = AudioDeviceStart(aggregateID, ioProcID);
    if (status != noErr) {
      if (ioProcID != nullptr) AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
      AudioHardwareDestroyAggregateDevice(aggregateID);
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"Unable to start the Core Audio output meter.", status);
    }

    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);
    NSMutableArray<NSNumber *> *resolvedNumbers =
        [NSMutableArray arrayWithCapacity:resolvedPids.size()];
    for (pid_t pid : resolvedPids) [resolvedNumbers addObject:@(pid)];
    emitJSON(@{
      @"type" : @"ready",
      @"source" : @"macOS process audio",
      @"pids" : resolvedNumbers,
    });

    while (running.load(std::memory_order_relaxed)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(33));
      const float level = meter.peak.exchange(0.0f, std::memory_order_relaxed);
      emitJSON(@{@"type" : @"level", @"level" : @(level)});
    }

    AudioDeviceStop(aggregateID, ioProcID);
    AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
    AudioHardwareDestroyAggregateDevice(aggregateID);
    AudioHardwareDestroyProcessTap(tapID);
    return 0;
  }
}
