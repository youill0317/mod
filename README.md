# mod

Claude Code에 붙여 쓰는 개인용 mod 모음입니다.

## shell-memo

메인 Claude가 포그라운드로 셸 명령이나 스크립트를 실행하는 동안, 진행 중 문구 옆에 지금 무엇을 하는지 짧은 메모를 붙입니다. Claude Code가 원래 보여 주는 문구, 시간, 토큰은 그대로 둡니다.

```
✻ Sauteing… · Kaggle 결과 기다리는 중 (7m 45s · ↓ 3.2k tokens · esc to interrupt)
✻ Sauteing… · 테스트 실행 중 · 코드 형식 검사 중 (12s · ↓ 1.1k tokens · esc to interrupt)
```

동작 방식은 다음과 같습니다.

- 명령이 시작되면 Claude가 명령과 함께 보낸 영어 설명을 바로 붙입니다.
- 1~2초 뒤 Haiku가 만든 쉬운 한국어 메모로 바꿉니다. 명령 실행은 이걸 기다리지 않습니다.
- 명령이 둘 이상이면 시작한 순서대로 옆으로 이어 붙이고, 줄이 모자라면 "외 N개"로 줄입니다.
- 명령이 끝나면 메모가 사라집니다.
- 서브 에이전트 창에서는 그 에이전트가 실행하는 명령의 메모를 붙입니다.
- 백그라운드로 실행한 명령과 셸 외 도구에는 붙이지 않습니다.
- 명령을 모델에 보내기 전에 토큰, 비밀번호, 키처럼 보이는 값을 가립니다.

메모를 만드는 모델은 `/config`에서 바꿀 수 있습니다. 기본값은 `haiku`입니다.

### 설치

터미널에서 Claude Code를 열고 다음을 입력합니다.

```
/plugin install shell-memo --marketplace youill0317/mod
```

마켓을 추가할지 물으면 `y`를 누르고, 범위는 user를 고릅니다.

### 개발

```
claude plugin validate shell-memo
claude plugin test shell-memo
```

설치 없이 한 세션에서만 써 보려면 `claude --plugin-dir ./shell-memo`로 실행합니다.
