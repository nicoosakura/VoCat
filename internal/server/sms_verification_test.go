package server

import (
	"testing"
	"time"

	"vocat/internal/store"
)

func TestExtractSMSVerificationCode(t *testing.T) {
	tests := []struct {
		body string
		want string
	}{
		{"【XX银行】您的验证码为 123456，请勿泄露给他人。", "123456"},
		{"验证码：888888，5分钟内有效。", "888888"},
		{"Your verification code is 456789.", "456789"},
		{"OTP: 123456 for your login.", "123456"},
		{"【APP】注册验证码为 654321，退订回T", "654321"},
		{"Your code is 135790, valid for 10 minutes.", "135790"},
		// 纯短数字正文兜底
		{"123456", "123456"},
		{"666888", "666888"},
		// 噪声不应误识别
		{"【通知】您的账户于 2024-01-01 发生支付 123 元。", ""},
		{"您的订单 20240101123456 已发货。", ""},
		{"这是一条普通短信。", ""},
		{"", ""},
		{"电话 13800001234，报警请拨打 110。", ""},
		// 长正文无关键词不兜底
		{"123456 987654 极速赛车计划群 点击链接下载", ""},
	}
	for _, test := range tests {
		if got := extractSMSVerificationCode(test.body); got != test.want {
			t.Errorf("extractSMSVerificationCode(%q) = %q, want %q", test.body, got, test.want)
		}
	}
}

func TestStoredSMSResponseAttachesVerificationCodeForInbound(t *testing.T) {
	message := store.SMSMessage{
		ID: 1, DeviceID: "dji-1", Peer: "10086", Direction: "inbound",
		Body: "【中国移动】验证码为 456789，请勿泄露。", Timestamp: time.Now(),
	}
	response := storedSMSResponse(message)
	if code, ok := response["verification_code"]; !ok || code != "456789" {
		t.Fatalf("inbound SMS verification_code = %v (found=%v), want 456789", code, ok)
	}
}

func TestStoredSMSResponseOmitsVerificationCodeForOutbound(t *testing.T) {
	message := store.SMSMessage{
		ID: 2, DeviceID: "dji-1", Peer: "10086", Direction: "outbound",
		Body: "验证码为 456789", Timestamp: time.Now(),
	}
	response := storedSMSResponse(message)
	if code, ok := response["verification_code"]; ok {
		t.Fatalf("outbound SMS should not expose verification_code, got %v", code)
	}
}