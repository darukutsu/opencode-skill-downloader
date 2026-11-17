# skill-downloader

Tries to universally download skills from online repositories, to your `$OPENCODE_CONFIG/skills` directory.

## Installation

Currently, copy project to your `opencode/plugins/skill-downloader` directory.

Later planning implementing release on npm so you can install it more simply.

## Configuration

```jsonc
  "plugins": [
    {
      "package": "./plugins/skill-downloader",
      "options": {
        // optional if you get rate limited, planning on improving github API calls somewhere in future
        "githubToken": "{env:GITHUB_ACCESS_TOKEN}"
      }
    }
  ],
  "skills": [
    "https://github.com/mattpocock/skills",
    "https://github.com/mukul975/anthropic-cybersecurity-skills",
    "https://github.com/anthropics/skills"
  ],
```

## Alternatives

[skills](https://www.npmjs.com/package/skills)\
[skillhub](https://github.com/iflytek/skillhub) or any other skill registry so you don't need to use this at all

## Disclaimer

This project was written using mudler/Qwen3.6-35B-A3B-uncensored-heretic-APEX-GGUF on AMD xtx7900 context 256k around 5GB on RAM.
Total consumed context was around 70k for initial plan, 200k on implementing first fully functional prototype. Took around 30 minutes.
Then catching bugs and invention of newer ones... lots of compressed context (2MB exported history) and around 2-3hours of doom-scrolling youtube.
This served me as POC whether smaller selfhosted models are good enough for my usecase, ofc would probably oneshot this with frontier models...

I tested only these repositories you see in configuration step, but should work with others. Without token unusable for bigger skill repositories but maybe will work...

I don't understand typescript at all.
I don't plan to maintain this, adding features, unless beneficial to me. I'm open to pull-requests, or fork it.

Might clutter `.local/share/opencode/log/opencode.log`, rest of debug logs are in `/tmp/opencode-skill-downloader-debug.log`, untested for Windows environment.

Hopefully one day, opencode will integrate similar capability into their `skills:` config entry
