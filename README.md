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

## dashboard

`/dashboard`를 입력하면 Claude가 지금까지의 작업 맥락을 보고 그에 맞는 실시간 대시보드를 설계해서 대화 옆 창에 띄웁니다. 미리 정해 둔 양식은 없습니다.

```
 Colab 학습
 l4a · L4
 ● 세션  training
 epoch  ██████████░░░░░░░░░░░░░░░░ 3/10 30%
 loss   ▇▅▄▂▁ 0.5
 서브 에이전트
 ● general-purpose  26분 · 도구 14회
   Bash: Add second GPU pass to run_gpu
```

- 창에는 글, 숫자, 진행 막대, 작은 그래프, 상태, 표, 서브 에이전트 현황을 넣을 수 있습니다.
- 계속 바뀌는 값은 Claude가 읽는 방법(명령, 파일, URL)을 함께 정해 두고, 이후 갱신은 mod가 정해진 간격으로 혼자 합니다. 창이 닫혀 있으면 읽지 않습니다.
- 명령으로 읽는 값이 있으면 처음 띄울 때 실행해도 되는지 한 번 묻습니다. 허용하지 않으면 그 값은 비워 둡니다.
- 서브 에이전트 현황은 이 세션의 이벤트로 바로 채웁니다.

| 입력 | 동작 |
|---|---|
| `/dashboard` | 대시보드가 있으면 열고, 없으면 Claude가 새로 설계 |
| `/dashboard <요청>` | 요청을 반영해 Claude가 다시 설계. 예: `/dashboard Colab 세션별로` |
| `/dashboard refresh` | 값을 지금 다시 읽기 |
| `/dashboard close` | 창 닫기 |

창이 대화 옆에 붙으려면 전체 화면 레이아웃(기본값)이어야 하고 터미널 폭이 110열 이상이어야 합니다. 그보다 좁으면 입력창 위에 열립니다.

### 설치

```
/plugin install dashboard --marketplace youill0317/mod
```

## 개발

```
claude plugin validate <mod 폴더>
claude plugin test <mod 폴더>
```

설치 없이 한 세션에서만 써 보려면 `claude --plugin-dir ./<mod 폴더>`로 실행합니다.
